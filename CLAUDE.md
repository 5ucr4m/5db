# 5db

A Tauri 2 desktop client for PostgreSQL and Redis. Rust backend, React 19
frontend, SQLite for local state.

## Commands

```sh
pnpm check          # lint + types + unit tests; no Docker needed, run this first
pnpm db:up          # Postgres 54329, Redis 63799, SSH bastion 22229, with seed data
pnpm test           # check + Rust (unit + integration) + Playwright e2e
pnpm tauri dev      # the native app
pnpm bridge         # the RPC over HTTP on 127.0.0.1:1430, for browser-only UI work
pnpm fmt            # Biome for TS, rustfmt for Rust
```

`pnpm test:native` only works on macOS. The e2e and integration suites need
`pnpm db:up` running.

## Conventions

- **Commit messages and all documentation are in English**, with Conventional
  Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`, `refactor:`).
- `pnpm lint` must be clean. Warnings are allowed and tracked (accessibility
  debt, hook dependencies); errors are not.
- Comments explain *why*, never *what*. Match the density of the surrounding
  code, which is deliberately compact.

## Architecture

**One RPC surface.** `src-tauri/src/rpc.rs::dispatch` is the only entry point
to the backend. It is called both by the Tauri `rpc` command (`lib.rs`) and by
the development HTTP bridge (`src/bin/devserver.rs`, behind the `devserver`
feature, never shipped). A new backend capability means a new arm in `dispatch`
and a call through `src/lib/rpc.ts`. Do not add Tauri commands alongside it.

**Values travel as text.** Postgres columns are selected as `col::text`, which
preserves every type (enums, arrays, ranges, jsonb) without a Rust-side
conversion. The type information comes separately from the catalog and drives
filters, editing and colours (`src/lib/format.ts::typeFamily`). Never add a
typed deserialization path for cell values.

**Three Postgres connections per session, plus a listener.** `PgSession` holds
`main` (browsing), `editor` (ad-hoc SQL, so a transaction left open cannot
block navigation) and `writer` (staged edits, applied in one transaction). They
are separate on purpose; do not collapse them. Notifications need a fourth,
opened lazily, because the others discard their async messages — only
`Connection::poll_message` surfaces a `NOTIFY`, and awaiting the connection,
which every other client here does, drops it.

**A NOTIFY never goes out on the listener's own connection.** Postgres hands a
self-notification back inside the message exchange of the query that sent it,
where the listener's driver never sees it. `pg::notify` uses the browsing
connection for that reason.

**Edits are staged, then atomic.** The grid accumulates pending changes in the
frontend; `pg.apply` sends them all and runs them in a single transaction,
keyed by primary key or, when there is none, by `ctid`.

## Where things live

| Path | What |
| --- | --- |
| `src-tauri/src/rpc.rs` | the RPC surface and session cache |
| `src-tauri/src/pg.rs` | Postgres: connect, introspect, filter, execute, edit |
| `src-tauri/src/rds.rs` | Redis: SCAN, typed reads, commands, INFO |
| `src-tauri/src/ssh.rs` | SSH tunnels (russh) on an ephemeral local port |
| `src-tauri/src/store.rs` | SQLite: connections, history, saved queries, settings |
| `src-tauri/src/secrets.rs` | the keychain vault, with a file fallback |
| `src-tauri/src/dump.rs` | finding pg_dump/pg_restore, and running them as jobs |
| `src/store/app.ts` | the Zustand store: sessions, tabs, toasts, confirmations |
| `src/lib/` | pure logic, and the only code with unit tests |
| `src/components/grid/DataGrid.tsx` | the hand-written virtualized grid |

## Things that will bite you

- **Secrets.** Passwords, SSH passwords and passphrases go to the OS keychain
  through `secrets.rs`; the SQLite row keeps those fields blank. Every write to
  the `connections` table must go through `Store::write_row`, which is the only
  thing that blanks them — going around it puts a plaintext secret on disk, and
  `secrets_never_reach_the_database_file` will catch it. A `ConnectionConfig`
  in memory does carry the real secrets, so never log one.
- **TLS verifies by default.** Postgres `verify-ca`/`verify-full` and Redis TLS
  check the certificate. Skipping the check is an explicit per-connection flag;
  do not widen that default.
- **File writes are validated.** `write_target` in `rpc.rs` rejects relative
  paths, traversal and anything inside the app data directory. Route every new
  write through it.
- **Docker fixtures hold generated key material.** `scripts/ssh-key.sh` and
  `scripts/tls-certs.sh` create it on demand and it is gitignored. Never commit
  a key or a certificate.
- **`Badge` upper-cases its content.** Right for a status word, wrong for an
  identifier — a Postgres channel or an object name must be shown exactly as it
  is. Pass `normal-case` for those.
- **Tailwind 4 CSS is excluded from Biome** (`src/styles.css`); its at-rules are
  not in Biome's grammar yet.
- **Two different switches get confused.** `wal_level = logical` enables logical
  replication, a continuous stream. Incremental *backups* are separate:
  physical, whole-cluster, PostgreSQL 17+, gated on `summarize_wal`. Neither
  makes `pg_dump` incremental — nothing does. `pg::capabilities` reports both
  separately and names what would have to change; never let the UI imply a
  scheduled logical dump could be anything but full.
- **Parallel dumps need the directory format.** `pg_dump` refuses `--jobs` with
  any other, so `DumpOptions::check` rejects the combination before a command is
  built. A directory dump is also measured by walking it: a folder's own
  metadata reports the size of the inode, not of what is inside.
- **A keychain that will not answer is never an empty one.** `Known::Unread` /
  `Loaded` / `Unavailable` exists because treating a failed read as an empty map
  meant writing that empty map back, and writing an empty map deletes the item —
  one refused authorisation destroyed every stored password. Never collapse
  those three states, never write without a successful read, and when the
  keychain is unusable leave the secret in the row rather than blanking it.
- **One keychain item, not one per secret.** macOS attaches an access list to
  each item and asks whenever an unrecognised binary reads one, so a item per
  connection per field meant a prompt per field after every rebuild. Everything
  is folded into `connection-secrets` and cached for the run. Never split it
  back up. The keychain tests use a service of their own, never the real one,
  and share its one item, so they take a mutex.
- **Backups shell out.** `pg_dump` and `pg_restore` are not bundled; `dump.rs`
  finds them and refuses a tool older than the server, because that is the one
  combination that silently produces an unusable dump. Connection details reach
  them through the environment only — a password in `argv` is readable by every
  process on the machine — and the config passed in is the one `effective()`
  returns, so a tunnelled connection is dumped through its tunnel.
- **Never pass `--clean` to `pg_restore`.** It drops only what the archive
  lists, object by object and without CASCADE, so a target holding one foreign
  key the backup has never seen fails the whole restore — and a target that ran
  one migration more than its source always does. Replacing means dropping the
  schemas the archive fills (`dump::read_listing`, `pg::replacing`). With one
  transaction that has to happen inside it, which pg_restore cannot do: it
  writes the script and psql applies it behind our statements. The script's
  COMMIT is pg_restore's own, on purpose — only a script written to the end has
  one, so a truncated archive rolls back instead of being applied as far as it
  got.
- **`russh` pulls `aws-lc-sys`**, which needs NASM on Windows and CMake
  everywhere. That is why the release workflow has those steps.
- **The updater signing key cannot be replaced.** The public half is in
  `tauri.conf.json` and the private half is the `TAURI_SIGNING_PRIVATE_KEY`
  repository secret. An installed app only accepts updates signed by that exact
  key, so losing it means every existing install is stuck on its current
  version and has to be reinstalled by hand. Keep a copy somewhere durable, and
  never rotate it without shipping a release that already carries the new public
  key.
