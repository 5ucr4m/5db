# Changelog

All notable changes to 5db. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

- Connection secrets are kept in a single keychain item instead of one per
  secret. macOS asks for authorisation per item whenever the binary changes, so
  the old layout meant a prompt for every connection after each update. Secrets
  written by an earlier build are folded in on first launch and the old items
  removed.

### Fixed

- Restoring over a database that already held something failed with "cannot
  drop constraint … because other objects depend on it" whenever the target had
  anything the backup did not, such as a foreign key from a later migration.
  `pg_restore --clean` drops only what the archive lists, one object at a time.
  The option is now **Replace what is there**: every schema the backup brings is
  emptied first, in the same transaction as the restore when "All or nothing"
  is on, so a restore that fails still leaves the target as it was. Schemas the
  backup does not touch are left alone.
- A connection marked read-only could still be restored into, because
  `pg_restore` opens a session of its own. It is refused now.
- Cancelling a parallel backup left its workers copying their tables to the
  end. `pg_dump` is asked to stop first, which takes them with it.
- A failed backup or restore is quoted from its first error rather than its
  last few lines, which often left out the error itself.

### Added

- Copying a database to another server in one step: it is backed up to a
  temporary folder, restored, checked and analysed, and the backup is deleted
  once the check passes. The check counts the rows of every table on both
  sides, with the source counted in the very snapshot the backup was taken
  from, so the source can stay in use and the numbers still have to agree
  exactly. A backup that was finished but never shown to have arrived is kept,
  with its path, instead of being deleted. A target that already holds tables
  is refused before the backup starts unless it may be replaced.
- A finished restore explains that the result is normally smaller than its
  source, and offers to collect the planner statistics a restore does not.
- A restore picks which database on the target server to replay into, and can
  create one there, instead of always using the one the connection was saved
  with.
- A replication screen: two endpoints and the link between them, which reports
  what each server allows before offering to start. The engine behind it is not
  built yet.
- Creating a database from the switcher in the sidebar, opened as soon as it exists.
- A directory backup format, the only one `pg_dump` can write with several
  workers at once, with a worker count and a parallel restore to match.
- Backup and restore, for moving a database to another server: everything,
  structure only or data only, as a compressed archive or plain SQL, restored
  into any other saved connection. Driven by `pg_dump`/`pg_restore`, which are
  discovered on the machine and version-checked against the server.

## [0.2.0] — 2026-10-27

First tagged release. Everything below landed on top of the initial commit.

### Added

- Connection secrets are kept in the OS keychain instead of the SQLite file.
  Existing connections are migrated on first launch, and a machine without a
  keychain keeps the previous behaviour and says so.
- `LISTEN`/`NOTIFY`: a panel that subscribes to channels and shows the payloads
  as they arrive, with a sender for trying one.
- Groups for connections, with the home screen and the side rail laid out by
  them and search matching the group name.
- A query plan viewer: `EXPLAIN (FORMAT JSON)` rendered as a tree with per-node
  self time, the slowest node highlighted and bad row estimates flagged.
- The open connections, tabs and window geometry are restored on launch.
- Signed releases and an in-app update check.
- PostgreSQL `verify-ca`, and a PEM bundle for a private certificate authority,
  so connections to RDS, Supabase, Cloud SQL and internal infrastructure can be
  verified instead of merely encrypted.
- A statement timeout per connection; the server cancels anything slower.
- Unit tests over the pure logic in `src/lib` (69 cases), Rust unit tests for
  the Redis URL builder, and integration tests covering every TLS mode.
- Continuous integration: lint, types and unit tests on every push, plus the
  Rust and Playwright suites against the Docker fixtures.
- Release builds for macOS (universal), Windows and Linux from a `v*` tag.
- Biome for TypeScript, clippy and rustfmt for Rust, pinned Node, pnpm and Rust
  versions.

### Changed

- **Breaking.** Redis TLS now verifies the server certificate. Every `rediss://`
  connection previously skipped verification with no way to turn it on. A
  connection that relies on an unverifiable certificate needs "Skip certificate
  check" enabled, or the CA supplied.
- The file-writing RPCs validate their destination: absolute paths only, no
  traversal, an existing directory, never inside the directory holding the
  credential store.
- The test bastion key and the test TLS material are generated on demand by
  `pnpm db:up` instead of living in the repository.

### Fixed

- `EXPLAIN ANALYZE` on a destructive statement skipped the production
  confirmation, because the check only looked at the first keyword and saw
  `EXPLAIN`. ANALYZE really runs the statement, so it is now judged on what it
  wraps; a plain `EXPLAIN`, which executes nothing, still asks nothing.
- `interval` columns were classified as numeric, because `^(small|big)?int`
  matches the start of "interval". They were offered numeric filter operators
  instead of the time ones.
- A stray `;` or a lone block comment produced an extra statement, which sent
  an empty query to the server and left a phantom result set in the panel.
- `<button>` elements without a `type` inside the connection form submitted the
  form instead of running their handler.
