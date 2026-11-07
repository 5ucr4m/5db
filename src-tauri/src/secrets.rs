//! Connection secrets live in the OS keychain rather than in the SQLite file,
//! so the file on disk is not sensitive material and another process running as
//! the same user cannot read a password out of it.
//!
//! Not every machine has a keychain: a headless Linux box, a container or CI
//! has no Secret Service. There the secrets stay in SQLite, which is what they
//! did before, and [`Vault::backend`] says so.
//!
//! Everything lives in **one** keychain item. macOS attaches an access list to
//! each item and asks the user whenever a binary it does not recognise reads
//! one, so a item per connection per field meant a prompt per connection per
//! field after every rebuild or update. One item is one prompt.

use std::collections::HashMap;
use std::sync::Mutex;

use keyring::v1::{Entry, Error as KeyringError};

use crate::store::ConnectionConfig;

const SERVICE: &str = "ai.leve.fivedb";
/// The single item every secret is folded into. Stable: renaming it strands
/// everything already stored.
const ACCOUNT: &str = "connection-secrets";

/// The fields of a connection that must never be written to SQLite.
#[derive(Copy, Clone)]
enum Field {
    Password,
    SshPassword,
    SshPassphrase,
}

impl Field {
    const ALL: [Field; 3] = [Field::Password, Field::SshPassword, Field::SshPassphrase];

    /// The keychain account name. Stable: changing it orphans stored secrets.
    fn account(self, id: &str) -> String {
        let name = match self {
            Field::Password => "password",
            Field::SshPassword => "ssh-password",
            Field::SshPassphrase => "ssh-passphrase",
        };
        format!("{id}/{name}")
    }

    fn of(self, c: &mut ConnectionConfig) -> &mut String {
        match self {
            Field::Password => &mut c.password,
            Field::SshPassword => &mut c.ssh_password,
            Field::SshPassphrase => &mut c.ssh_passphrase,
        }
    }
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Backend {
    /// The OS keychain: Keychain on macOS, Credential Manager on Windows,
    /// Secret Service on Linux.
    Keychain,
    /// No keychain is reachable, so secrets stay in the SQLite file.
    File,
}

pub struct Vault {
    backend: Backend,
    /// The whole map, read from the keychain once per run. Without this every
    /// listing would reach for the keychain again, and on a machine where the
    /// item needs authorising that is a prompt each time.
    cache: Mutex<Option<HashMap<String, String>>>,
}

impl Vault {
    /// Keeps the secrets in the SQLite file. The escape hatch for a machine
    /// without a keychain, and what the test suite uses so it never touches the
    /// developer's real one.
    pub fn file() -> Self {
        Vault {
            backend: Backend::File,
            cache: Mutex::new(None),
        }
    }

    /// Probes the keychain once, by round-tripping a canary, because a backend
    /// that is present but locked fails only on use.
    pub fn open() -> Self {
        if std::env::var("FIVEDB_SECRETS").as_deref() == Ok("file") {
            return Vault::file();
        }
        let probe = || -> Result<(), KeyringError> {
            let e = Entry::new(SERVICE, "probe")?;
            e.set_password("probe")?;
            let got = e.get_password()?;
            let _ = e.delete_credential();
            if got == "probe" {
                Ok(())
            } else {
                Err(KeyringError::NoEntry)
            }
        };
        match probe() {
            Ok(()) => {
                let v = Vault {
                    backend: Backend::Keychain,
                    cache: Mutex::new(None),
                };
                v.absorb_legacy_items();
                v
            }
            Err(e) => {
                eprintln!("5db: no usable keychain ({e}); connection secrets will stay in the local database file.");
                Vault::file()
            }
        }
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    fn entry() -> Result<Entry, KeyringError> {
        Entry::new(SERVICE, ACCOUNT)
    }

    /// The whole map, read from the keychain at most once per run.
    fn map(&self) -> HashMap<String, String> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(m) = cache.as_ref() {
            return m.clone();
        }
        let loaded = Self::entry()
            .and_then(|e| e.get_password())
            .ok()
            .and_then(|json| serde_json::from_str::<HashMap<String, String>>(&json).ok())
            .unwrap_or_default();
        *cache = Some(loaded.clone());
        loaded
    }

    /// Writes the map back. Returns false when the keychain would not take it,
    /// so the caller can keep the secret in the row rather than lose it.
    fn put(&self, map: HashMap<String, String>) -> bool {
        let json = match serde_json::to_string(&map) {
            Ok(j) => j,
            Err(_) => return false,
        };
        let written = Self::entry().and_then(|e| {
            if map.is_empty() {
                match e.delete_credential() {
                    Err(KeyringError::NoEntry) => Ok(()),
                    other => other,
                }
            } else {
                e.set_password(&json)
            }
        });
        match written {
            Ok(()) => {
                *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(map);
                true
            }
            Err(e) => {
                eprintln!("5db: could not write the keychain ({e}); the secrets will stay in the local database file.");
                false
            }
        }
    }

    /// Folds the old one-item-per-field layout into the single item and removes
    /// it. Costs one authorisation per leftover item, once, and then never
    /// again — which is the whole point of consolidating.
    fn absorb_legacy_items(&self) {
        let mut map = self.map();
        let before = map.len();
        // Only the ids already named in the item can be checked cheaply, so the
        // sweep is driven by what the old layout would have been called. The
        // store calls this again with its own ids through `absorb_legacy`.
        let keys: Vec<String> = map.keys().cloned().collect();
        for key in keys {
            if let Some((id, _)) = key.split_once('/')
                && self.drain_legacy(id, &mut map)
            {
                continue;
            }
        }
        if map.len() != before {
            self.put(map);
        }
    }

    /// Moves every legacy item belonging to one connection into the map.
    /// Returns true when something was moved.
    fn drain_legacy(&self, id: &str, map: &mut HashMap<String, String>) -> bool {
        let mut moved = false;
        for f in Field::ALL {
            let account = f.account(id);
            if map.contains_key(&account) {
                continue;
            }
            if let Ok(e) = Entry::new(SERVICE, &account)
                && let Ok(value) = e.get_password()
            {
                map.insert(account, value);
                let _ = e.delete_credential();
                moved = true;
            }
        }
        moved
    }

    /// Pulls a connection's secrets out of the old layout, if they are still
    /// there. Called by the store, which is the only thing that knows the ids.
    pub fn absorb_legacy(&self, ids: &[String]) {
        if self.backend != Backend::Keychain {
            return;
        }
        let mut map = self.map();
        let mut moved = false;
        for id in ids {
            moved |= self.drain_legacy(id, &mut map);
        }
        if moved {
            self.put(map);
        }
    }

    /// Returns the config as it should be written to SQLite: with the secrets
    /// moved into the keychain and the fields blanked. The caller's own copy is
    /// untouched, so what it returns to the frontend still works.
    pub fn store(&self, c: &ConnectionConfig) -> ConnectionConfig {
        let mut row = c.clone();
        if self.backend == Backend::File {
            return row;
        }
        let mut map = self.map();
        let mut taken: Vec<(Field, String)> = Vec::new();
        for f in Field::ALL {
            let value = std::mem::take(f.of(&mut row));
            let key = f.account(&c.id);
            // An empty field is a cleared secret, so it leaves the map.
            if value.is_empty() {
                map.remove(&key);
            } else {
                map.insert(key, value.clone());
            }
            taken.push((f, value));
        }
        if !self.put(map) {
            // Losing the secret silently would lock the user out of their own
            // connection, so it goes back into the row instead.
            for (f, value) in taken {
                *f.of(&mut row) = value;
            }
        }
        row
    }

    /// Fills in the secrets a stored row left blank.
    pub fn load(&self, c: &mut ConnectionConfig) {
        if self.backend == Backend::File {
            return;
        }
        let map = self.map();
        for f in Field::ALL {
            if !f.of(c).is_empty() {
                continue; // Still in the file: written before the keychain was used.
            }
            if let Some(v) = map.get(&f.account(&c.id)) {
                *f.of(c) = v.clone();
            }
        }
    }

    /// Drops every secret belonging to a deleted connection.
    pub fn forget(&self, id: &str) {
        if self.backend == Backend::File {
            return;
        }
        let mut map = self.map();
        let before = map.len();
        for f in Field::ALL {
            map.remove(&f.account(id));
        }
        if map.len() != before {
            self.put(map);
        }
    }

    /// True when the row still carries a secret that belongs in the keychain.
    pub fn needs_migration(&self, c: &ConnectionConfig) -> bool {
        self.backend == Backend::Keychain
            && (!c.password.is_empty() || !c.ssh_password.is_empty() || !c.ssh_passphrase.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Consolidating into one keychain item means the keychain tests share one
    /// resource, so they have to take turns.
    pub(super) static KEYCHAIN: Mutex<()> = Mutex::new(());

    fn cfg(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            password: "pg-secret".into(),
            ssh_password: "ssh-secret".into(),
            ssh_passphrase: String::new(),
            host: "localhost".into(),
            ..Default::default()
        }
    }

    #[test]
    fn file_backend_leaves_the_secrets_where_they_are() {
        let vault = Vault::file();
        let row = vault.store(&cfg("file-test"));
        assert_eq!(row.password, "pg-secret");
        assert!(!vault.needs_migration(&row));
    }

    #[test]
    fn keychain_round_trip() {
        let _guard = KEYCHAIN.lock().unwrap_or_else(|e| e.into_inner());
        let vault = Vault::open();
        if vault.backend() != Backend::Keychain {
            // No Secret Service here, which is the case in CI; the file path is
            // covered above.
            return;
        }
        let id = format!("5db-selftest-{}-{:?}", std::process::id(), std::thread::current().id());
        let c = cfg(&id);

        // What goes to SQLite carries no secret, and an empty field stores nothing.
        let row = vault.store(&c);
        assert_eq!(row.password, "");
        assert_eq!(row.ssh_password, "");
        assert_eq!(row.host, "localhost", "the rest of the config survives");
        assert!(!vault.needs_migration(&row));

        // Reading the row back restores exactly what was stored.
        let mut back = row.clone();
        vault.load(&mut back);
        assert_eq!(back.password, "pg-secret");
        assert_eq!(back.ssh_password, "ssh-secret");
        assert_eq!(back.ssh_passphrase, "", "an empty secret stays empty");

        // Clearing a field removes it rather than leaving the old value behind.
        let mut cleared = back.clone();
        cleared.password = String::new();
        let row = vault.store(&cleared);
        let mut back = row.clone();
        vault.load(&mut back);
        assert_eq!(back.password, "", "a cleared password must not come back");
        assert_eq!(back.ssh_password, "ssh-secret");

        vault.forget(&id);
        let mut gone = row.clone();
        vault.load(&mut gone);
        assert_eq!(gone.ssh_password, "", "forget must remove every field");
    }
}

#[cfg(test)]
mod one_item_tests {
    use super::tests::KEYCHAIN;
    use super::*;

    /// Everything a connection can hide, in one place.
    fn cfg(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            password: "pg".into(),
            ssh_password: "ssh".into(),
            ssh_passphrase: "pp".into(),
            ..Default::default()
        }
    }

    #[test]
    fn the_keychain_holds_one_item_for_every_connection() {
        let _guard = KEYCHAIN.lock().unwrap_or_else(|e| e.into_inner());
        let vault = Vault::open();
        if vault.backend() != Backend::Keychain {
            return; // No Secret Service here; the file path is covered elsewhere.
        }
        let tag = format!("5db-onetest-{}-{:?}", std::process::id(), std::thread::current().id());
        let a = format!("{tag}-a");
        let b = format!("{tag}-b");

        // Whatever is already stored belongs to the developer; keep it intact.
        let before = vault.map();

        let row_a = vault.store(&cfg(&a));
        let row_b = vault.store(&cfg(&b));
        assert_eq!(row_a.password, "", "the row written to SQLite carries no secret");
        assert_eq!(row_b.ssh_passphrase, "");

        // Two connections, three secrets each, and still a single keychain item.
        let item = Entry::new(SERVICE, ACCOUNT).unwrap().get_password().unwrap();
        let map: HashMap<String, String> = serde_json::from_str(&item).unwrap();
        assert_eq!(map.get(&format!("{a}/password")).map(String::as_str), Some("pg"));
        assert_eq!(map.get(&format!("{b}/ssh-passphrase")).map(String::as_str), Some("pp"));

        let mut back = row_a.clone();
        vault.load(&mut back);
        assert_eq!(back.password, "pg");
        assert_eq!(back.ssh_password, "ssh");

        // Clearing one field removes just that key.
        let mut cleared = back.clone();
        cleared.ssh_password = String::new();
        let row = vault.store(&cleared);
        let mut back = row.clone();
        vault.load(&mut back);
        assert_eq!(back.ssh_password, "", "a cleared secret must not come back");
        assert_eq!(back.password, "pg", "and its neighbours must survive");

        vault.forget(&a);
        vault.forget(&b);
        let mut gone = row_b.clone();
        vault.load(&mut gone);
        assert_eq!(gone.password, "", "forget removes every field of that connection");

        // The developer's own secrets are exactly as they were.
        assert_eq!(vault.map(), before, "the test must leave the real item untouched");
    }

    #[test]
    fn secrets_written_by_an_older_build_are_folded_in_and_the_old_items_removed() {
        let _guard = KEYCHAIN.lock().unwrap_or_else(|e| e.into_inner());
        let vault = Vault::open();
        if vault.backend() != Backend::Keychain {
            return;
        }
        let id = format!("5db-legacy-{}-{:?}", std::process::id(), std::thread::current().id());
        let before = vault.map();

        // The old layout: one item per field.
        Entry::new(SERVICE, &format!("{id}/password"))
            .unwrap()
            .set_password("old-pg")
            .unwrap();
        Entry::new(SERVICE, &format!("{id}/ssh-password"))
            .unwrap()
            .set_password("old-ssh")
            .unwrap();

        vault.absorb_legacy(std::slice::from_ref(&id));

        let mut row = ConnectionConfig {
            id: id.clone(),
            ..Default::default()
        };
        vault.load(&mut row);
        assert_eq!(row.password, "old-pg", "the value has to survive the move");
        assert_eq!(row.ssh_password, "old-ssh");

        // The old items are gone, so they can never prompt again.
        assert!(
            Entry::new(SERVICE, &format!("{id}/password"))
                .unwrap()
                .get_password()
                .is_err(),
            "the legacy item must be deleted once it has been folded in"
        );

        vault.forget(&id);
        assert_eq!(vault.map(), before);
    }
}
