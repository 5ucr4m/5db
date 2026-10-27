# Changelog

All notable changes to 5db. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

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

- `interval` columns were classified as numeric, because `^(small|big)?int`
  matches the start of "interval". They were offered numeric filter operators
  instead of the time ones.
- A stray `;` or a lone block comment produced an extra statement, which sent
  an empty query to the server and left a phantom result set in the panel.
- `<button>` elements without a `type` inside the connection form submitted the
  form instead of running their handler.
