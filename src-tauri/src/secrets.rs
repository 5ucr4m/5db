//! Connection secrets live in the OS keychain rather than in the SQLite file,
//! so the file on disk is not sensitive material and another process running as
//! the same user cannot read a password out of it.
//!
//! Not every machine has a keychain: a headless Linux box, a container or CI
//! has no Secret Service. There the secrets stay in SQLite, which is what they
//! did before, and [`Vault::backend`] says so.

use keyring::v1::{Entry, Error as KeyringError};

use crate::store::ConnectionConfig;

const SERVICE: &str = "ai.leve.fivedb";

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
}

impl Vault {
    /// Keeps the secrets in the SQLite file. The escape hatch for a machine
    /// without a keychain, and what the test suite uses so it never touches the
    /// developer's real one.
    pub fn file() -> Self {
        Vault { backend: Backend::File }
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
            Ok(()) => Vault {
                backend: Backend::Keychain,
            },
            Err(e) => {
                eprintln!("5db: no usable keychain ({e}); connection secrets will stay in the local database file.");
                Vault { backend: Backend::File }
            }
        }
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    /// Returns the config as it should be written to SQLite: with the secrets
    /// moved into the keychain and the fields blanked. The caller's own copy is
    /// untouched, so what it returns to the frontend still works.
    pub fn store(&self, c: &ConnectionConfig) -> ConnectionConfig {
        let mut row = c.clone();
        if self.backend == Backend::File {
            return row;
        }
        for f in Field::ALL {
            let value = std::mem::take(f.of(&mut row));
            let account = f.account(&c.id);
            let written = Entry::new(SERVICE, &account).and_then(|e| {
                if value.is_empty() {
                    // Deleting is how a cleared field is expressed; an entry
                    // that was never there is not an error.
                    match e.delete_credential() {
                        Err(KeyringError::NoEntry) => Ok(()),
                        other => other,
                    }
                } else {
                    e.set_password(&value)
                }
            });
            if let Err(e) = written {
                // Losing the secret silently would lock the user out of their
                // own connection, so keep it in the row instead.
                eprintln!(
                    "5db: could not store {account} in the keychain ({e}); keeping it in the local database file."
                );
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
        for f in Field::ALL {
            if !f.of(c).is_empty() {
                continue; // Still in the file: written before the keychain was used.
            }
            if let Ok(value) = Entry::new(SERVICE, &f.account(&c.id)).and_then(|e| e.get_password()) {
                *f.of(c) = value;
            }
        }
    }

    /// Drops every secret belonging to a deleted connection.
    pub fn forget(&self, id: &str) {
        if self.backend == Backend::File {
            return;
        }
        for f in Field::ALL {
            if let Ok(e) = Entry::new(SERVICE, &f.account(id)) {
                let _ = e.delete_credential();
            }
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
        let vault = Vault { backend: Backend::File };
        let row = vault.store(&cfg("file-test"));
        assert_eq!(row.password, "pg-secret");
        assert!(!vault.needs_migration(&row));
    }

    #[test]
    fn keychain_round_trip() {
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
