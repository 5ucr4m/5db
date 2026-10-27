# 5db

A desktop client for **PostgreSQL** and **Redis** in the spirit of Postico, built with Tauri 2 (Rust) + React. A native app of about 8 MB.

## Features

**Connections**
- Create, edit, duplicate and delete connections saved locally (SQLite in the app data directory, file mode `0600`).
- Passwords, SSH passwords and key passphrases live in the **OS keychain** — Keychain on macOS, Credential Manager on Windows, Secret Service on Linux — not in the database file, which therefore holds nothing sensitive. Existing connections are migrated on first launch. A machine with no keychain falls back to the file and says so on stderr.
- **Test a connection** before saving, with the server version and the latency; server errors are shown exactly as they came.
- Import from a URL (`postgres://…`, `redis://…`, `rediss://…`).
- A colour and an **environment** (local, dev, staging, production). Production connections get a striped band across the top and ask for confirmation before `DROP`, `TRUNCATE`, a `DELETE`/`UPDATE` without `WHERE`, and before saving edits.
- **Read-only** sessions (the server rejects every write).
- PostgreSQL SSL in all five libpq modes (disable, prefer, require, verify-ca, verify-full) and TLS for Redis, **both verifying the certificate by default**. A private CA (RDS, Supabase, Cloud SQL, internal infrastructure) is supplied as a PEM file; skipping verification is an explicit, labelled choice.
- A **statement timeout** per connection: the server cancels anything slower. Zero leaves it unlimited.
- An **SSH tunnel** with a password or a private key (passphrase supported).
- Many connections open at once, switched from the side rail.
- **Groups**: a free-text folder per connection. The home screen groups by it, the rail draws a rule between groups, and search matches the group name.

**PostgreSQL**
- A browser for schemas, tables, views, materialized views, foreign tables and functions, with search and a row estimate. Switch database.
- A virtualized grid (rows and columns) with types coloured by family, column resizing and auto-fit, selection by cell, range or row, and copy as TSV.
- **Sorting** by clicking a header (shift-click for several columns).
- Visual per-column **filters** with typed operators (=, ≠, <, >, between, contains, starts/ends with, regex, is one of, null, empty, true/false), an all/any mode, a free-form SQL condition and search across every column.
- Pagination with a count (estimated on very large tables).
- **Editing**: double-click or type straight into a cell, insert rows (DEFAULT values), delete, "Set NULL". Changes stay pending, can be reviewed as SQL, and are saved in a **single transaction** (`⌘S`), all or nothing. Tables without a primary key are edited by `ctid`.
- A row inspector with formatted JSON.
- **Foreign key** navigation (opens the referenced row).
- **Structure** tabs (columns, indexes, foreign keys, incoming references, constraints, triggers) and generated **DDL**.
- Export as CSV, JSON, Markdown and `INSERT`; export a whole table through `COPY`.
- Truncate, drop and refresh a materialized view.
- **Server activity** (`pg_stat_activity`) with cancel and terminate for backends.
- **`LISTEN`/`NOTIFY`**: subscribe to channels and watch payloads arrive, formatted when they are JSON, with the sender's backend pid. A sender is built in for trying one out.

**SQL editor**
- CodeMirror with the PostgreSQL dialect and autocomplete for tables and columns.
- `⌘↵` runs the statement under the cursor (or the selection), `⇧⌘↵` runs everything; several result sets.
- A **plan viewer**: Explain shows the planner's estimate without running anything, Analyze runs the statement and measures it. The plan is a tree with the time spent in each node on its own, the slowest node highlighted, and a warning where the row estimate was ten times or more out — which is usually why the plan is bad. Any `EXPLAIN (FORMAT JSON)` you type renders the same way.
- Errors with SQLSTATE, detail and hint, and the offending fragment underlined in the editor.
- **Cancel** long queries; a row limit with a truncation warning.
- Transactions persist across executions (`BEGIN` … `COMMIT`), isolated from browsing.
- A **history** of everything executed (duration, rows, error), with search, re-run and delete.
- **Saved queries** with a name (`⌘S`).

**Redis**
- Browsing with `SCAN` (never blocking the server), a match pattern, a type filter, a tree view by namespace, incremental loading, and switching db with a key count.
- Viewing and editing per type: string (formatted JSON), hash, list, set, sorted set and stream.
- TTL (set, remove), rename, delete, create key.
- A **console** with history (↑ ↓) and output in `redis-cli` format.
- A server panel (memory, ops/s, hit rate, keyspace and the whole `INFO`).

**General**
- A `⌘K` command palette, tabs with preview, light/dark/system theme.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘N` | New connection (home screen) |
| `⌘T` / `⌘W` | New query / close tab |
| `⌘1`…`⌘9`, `⇧⌘[` `⇧⌘]` | Switch tab |
| `⌘↵` / `⇧⌘↵` | Run the statement / run everything |
| `⌘S` | Save table edits or the query |
| `⌘R` | Reload the table |
| `⌘F` / `⇧⌘F` | Search / add a filter |
| `⌘I` | Row inspector |
| `⌘⌫` | Delete the selected rows |

## Development

Requirements: stable Rust, Node 22 + pnpm, Docker. The exact versions are pinned in `rust-toolchain.toml` and in `packageManager`.

```sh
pnpm install
pnpm db:up          # Postgres (54329), Redis (63799) and an SSH bastion (22229) with test data
pnpm tauri dev      # the native app
```

To work on the interface alone in a browser, run `pnpm bridge` (which exposes the app's own RPC on `127.0.0.1:1430`) and `pnpm dev`, then open `http://localhost:1420`.

### Tests

```sh
pnpm check          # lint, types and unit tests — needs no Docker
pnpm test:unit      # vitest over the pure logic in src/lib
pnpm test:backend   # Rust unit and integration tests against the containers (SSH tunnel, TLS, cancellation)
pnpm test:e2e       # Playwright in Chromium and WebKit (the engine behind macOS WKWebView)
pnpm test:native    # a smoke test inside the real Tauri app, over the IPC bridge (macOS)
pnpm test           # check + backend + e2e
```

`pnpm fmt` formats everything (Biome for TypeScript, rustfmt for Rust); `pnpm lint` and `pnpm lint:rust` check without writing.

`pnpm install` points `core.hooksPath` at `.githooks`, so a commit runs
everything in `pnpm check` plus the Rust lints first. `git commit --no-verify`
skips it.

### Build

```sh
pnpm tauri build    # produces the .app / installers in src-tauri/target/release/bundle
```

CI builds macOS (universal), Windows and Linux on every `v*` tag, and on demand from the Actions tab.

Tagged builds are signed for the updater, and the app checks
`releases/latest/download/latest.json` shortly after launch; "Check for
updates" in the command palette asks on demand. An update signed by anything
other than the key in `tauri.conf.json` is refused. The macOS bundle is not yet
Apple-signed or notarized, so the first launch needs right-click → Open.

## Architecture

- `src-tauri/src/rpc.rs` — the single RPC surface (`dispatch`), used both by the Tauri `rpc` command and by the development HTTP bridge.
- `src-tauri/src/pg.rs` — Postgres sessions (one connection for browsing, one for the editor, one for edits), introspection, filters with typed parameters, transactional edits, streaming SQL execution and cancellation.
- `src-tauri/src/rds.rs` — Redis (`ConnectionManager`), SCAN, typed reads, commands and `INFO`.
- `src-tauri/src/ssh.rs` — SSH tunnels (russh) on an ephemeral local port.
- `src-tauri/src/store.rs` — connections, history, saved queries and small settings in SQLite.
- `src/` — React 19 + Zustand + Tailwind 4; a hand-written virtualized grid (`components/grid/DataGrid.tsx`); CodeMirror loaded on demand.

Values travel as text (`col::text`), which preserves any type (enums, arrays, ranges, jsonb) without loss; the types come from the catalog and drive filters, editing and colours.

`pnpm db:up` generates the **test-only** key material the containers use, and none of it lives in the repository: `scripts/ssh-key.sh` creates the bastion key and `scripts/tls-certs.sh` creates the CA and the certificate the test Postgres serves TLS with.
