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

**Three Postgres connections per session.** `PgSession` holds `main`
(browsing), `editor` (ad-hoc SQL, so a transaction left open cannot block
navigation) and `writer` (staged edits, applied in one transaction). They are
separate on purpose; do not collapse them.

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
- **Tailwind 4 CSS is excluded from Biome** (`src/styles.css`); its at-rules are
  not in Biome's grammar yet.
- **`russh` pulls `aws-lc-sys`**, which needs NASM on Windows and CMake
  everywhere. That is why the release workflow has those steps.
