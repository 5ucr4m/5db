# Changelog

All notable changes to 5db. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

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
