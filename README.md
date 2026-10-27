# 5db

Cliente desktop para **PostgreSQL** e **Redis**, no espírito do Postico, construído com Tauri 2 (Rust) + React. App nativo de ~8 MB.

## Recursos

**Conexões**
- Cadastro, edição, duplicação e exclusão de conexões salvas localmente (SQLite no diretório de dados do app, arquivo com permissão `0600`).
- **Testar conexão** antes de salvar, com versão do servidor e latência; erros do servidor exibidos como vieram.
- Importação por URL (`postgres://…`, `redis://…`, `rediss://…`).
- Cor e **ambiente** (local, dev, staging, produção). Conexões de produção ganham uma faixa listrada no topo e pedem confirmação antes de `DROP`, `TRUNCATE`, `DELETE`/`UPDATE` sem `WHERE` e de salvar edições.
- Sessão **somente leitura** (o servidor rejeita escritas).
- SSL (prefer, require, verify-full) e TLS para Redis.
- **Túnel SSH** com senha ou chave privada (com passphrase).
- Várias conexões abertas ao mesmo tempo, alternadas pelo trilho lateral.

**PostgreSQL**
- Navegador de schemas, tabelas, views, materialized views, tabelas estrangeiras e funções, com busca e estimativa de linhas. Troca de database.
- Grade virtualizada (linhas e colunas) com tipos coloridos por família, redimensionamento e auto-ajuste de colunas, seleção por célula/intervalo/linha, cópia em TSV.
- **Ordenação** clicando no cabeçalho (Shift+clique para múltiplas colunas).
- **Filtros** visuais por coluna com operadores tipados (=, ≠, <, >, entre, contém, começa/termina com, regex, é um de, nulo, vazio, verdadeiro/falso), modo "todos/qualquer", condição SQL livre e busca em todas as colunas.
- Paginação com contagem (estimada em tabelas enormes).
- **Edição**: duplo clique ou digitação direta, inserção de linhas (valores DEFAULT), exclusão, "Set NULL". As mudanças ficam pendentes, podem ser revisadas como SQL e são salvas numa **única transação** (`⌘S`), tudo ou nada. Tabelas sem chave primária são editadas por `ctid`.
- Inspetor de linha com JSON formatado.
- Navegação por **chave estrangeira** (abre a linha referenciada).
- Abas de **estrutura** (colunas, índices, FKs, referências de entrada, constraints, triggers) e **DDL** gerado.
- Exportar CSV, JSON, Markdown e `INSERT`; exportação da tabela inteira via `COPY`.
- Truncate, drop e refresh de materialized view.
- **Atividade do servidor** (`pg_stat_activity`) com cancelar/terminar backends.

**Editor SQL**
- CodeMirror com dialeto PostgreSQL e autocomplete de tabelas e colunas.
- `⌘↵` executa o statement sob o cursor (ou a seleção), `⇧⌘↵` executa tudo; vários result sets; `EXPLAIN`.
- Erros com SQLSTATE, detalhe e dica, e o trecho com erro sublinhado no editor.
- **Cancelar** queries longas; limite de linhas com aviso de truncamento.
- Transações persistem entre execuções (`BEGIN` … `COMMIT`), isoladas da navegação.
- **Histórico** de tudo que foi executado (duração, linhas, erro), com busca, reexecução e remoção.
- **Queries salvas** com nome (`⌘S`).

**Redis**
- Navegação com `SCAN` (sem bloquear o servidor), padrão de busca, filtro por tipo, visão em árvore por namespace, carregamento incremental, troca de db com contagem de chaves.
- Visualização e edição por tipo: string (JSON formatado), hash, list, set, sorted set e stream.
- TTL (definir, remover), renomear, excluir, criar chave.
- **Console** com histórico (↑ ↓) e saída no formato do `redis-cli`.
- Painel do servidor (memória, ops/s, taxa de acerto, keyspace e todo o `INFO`).

**Geral**
- Paleta de comandos `⌘K`, abas com pré-visualização, tema claro/escuro/sistema.

## Atalhos

| Atalho | Ação |
| --- | --- |
| `⌘K` | Paleta de comandos |
| `⌘N` | Nova conexão (tela inicial) |
| `⌘T` / `⌘W` | Nova query / fechar aba |
| `⌘1`…`⌘9`, `⇧⌘[` `⇧⌘]` | Trocar de aba |
| `⌘↵` / `⇧⌘↵` | Executar statement / tudo |
| `⌘S` | Salvar edições da tabela ou a query |
| `⌘R` | Recarregar tabela |
| `⌘F` / `⇧⌘F` | Buscar / adicionar filtro |
| `⌘I` | Inspetor de linha |
| `⌘⌫` | Excluir linhas selecionadas |

## Desenvolvimento

Requisitos: Rust estável, Node 22 + pnpm, Docker.

```sh
pnpm install
pnpm db:up          # Postgres (54329), Redis (63799) e bastion SSH (22229) com dados de teste
pnpm tauri dev      # app nativo
```

Para trabalhar só na interface no navegador, rode `pnpm bridge` (expõe o mesmo RPC do app em `127.0.0.1:1430`) e `pnpm dev`, e abra `http://localhost:1420`.

### Testes

```sh
pnpm test:backend   # integração do Rust contra os containers (inclui túnel SSH e cancelamento)
pnpm test:e2e       # Playwright em Chromium e WebKit (motor do WKWebView do macOS)
pnpm test:native    # smoke test dentro do app Tauri real, pela ponte IPC (macOS)
pnpm test           # typecheck + backend + e2e
```

### Build

```sh
pnpm tauri build    # gera o .app / instaladores em src-tauri/target/release/bundle
```

## Arquitetura

- `src-tauri/src/rpc.rs` — superfície RPC única (`dispatch`), usada pelo comando Tauri `rpc` e pelo bridge HTTP de desenvolvimento.
- `src-tauri/src/pg.rs` — sessões Postgres (uma conexão para navegação, outra para o editor, outra para edições), introspecção, filtros com parâmetros tipados, edições transacionais, execução de SQL com streaming e cancelamento.
- `src-tauri/src/rds.rs` — Redis (`ConnectionManager`), SCAN, leitura por tipo, comandos e `INFO`.
- `src-tauri/src/ssh.rs` — túneis SSH (russh) com porta local efêmera.
- `src-tauri/src/store.rs` — conexões, histórico, queries salvas e preferências em SQLite.
- `src/` — React 19 + Zustand + Tailwind 4; grade virtualizada própria (`components/grid/DataGrid.tsx`); CodeMirror carregado sob demanda.

Valores trafegam como texto (`col::text`), o que preserva qualquer tipo (enums, arrays, ranges, jsonb) sem perda; os tipos vêm do catálogo e orientam filtros, edição e cores.

`pnpm db:up` gera `docker/ssh/test_ed25519`, uma chave **somente para testes** do bastion local.
Ela não está no repositório; `scripts/ssh-key.sh` a recria quando falta.
