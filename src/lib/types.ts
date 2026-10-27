export type ConnectionKind = "postgres" | "redis";
export type EnvTag = "local" | "dev" | "staging" | "prod";

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: ConnectionKind;
  color: string;
  env: EnvTag;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: "disable" | "prefer" | "require" | "verify-full";
  redisDb: number;
  tls: boolean;
  readOnly: boolean;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPassword: string;
  sshKeyPath: string;
  sshPassphrase: string;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
}

export interface PgServerInfo {
  version: string;
  serverVersion: string;
  user: string;
  database: string;
  sizeBytes: number;
  readOnly: boolean;
}

export type ObjectKind = "table" | "view" | "matview" | "foreign";

export interface PgObject {
  schema: string;
  name: string;
  kind: ObjectKind;
  rowEstimate: number | null;
  sizeBytes: number | null;
  comment: string | null;
}

export interface PgFunction {
  schema: string;
  name: string;
  args: string;
  returns: string;
  kind: "function" | "procedure" | "aggregate" | "window";
  oid: number;
}

export interface PgObjects {
  schemas: string[];
  objects: PgObject[];
  functions: PgFunction[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  castType: string;
  category: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
  position: number;
  isPk: boolean;
  identity: boolean;
  generated: boolean;
  enumValues: string[] | null;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  definition: string;
}

export interface TableStructure {
  schema: string;
  name: string;
  kind: ObjectKind;
  rowEstimate: number | null;
  totalBytes: number;
  tableBytes: number;
  comment: string | null;
  viewDefinition: string | null;
  owner: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
  referencedBy: { name: string; schema: string; table: string; columns: string[]; definition: string }[];
  indexes: { name: string; definition: string; unique: boolean; primary: boolean; sizeBytes: number; method: string }[];
  constraints: { name: string; type: string; definition: string }[];
  triggers: { name: string; definition: string; enabled: boolean }[];
}

export type Cell = string | null;

export interface RowsPage {
  columns: ColumnInfo[];
  rows: Cell[][];
  rowIds: (string | null)[];
  total: number | null;
  totalEstimated: boolean;
  editable: boolean;
  durationMs: number;
  sql: string;
}

export type FilterOp =
  | "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
  | "contains" | "not_contains" | "starts_with" | "ends_with" | "regex"
  | "in" | "not_in" | "between"
  | "is_null" | "not_null" | "is_empty" | "is_true" | "is_false";

export interface Filter {
  id: string;
  column: string;
  op: FilterOp;
  value?: string;
  value2?: string;
  enabled: boolean;
}

export interface SortSpec {
  column: string;
  desc: boolean;
}

export interface ResultSet {
  kind: "rows" | "command";
  columns: string[];
  columnTypes: string[];
  rows: Cell[][];
  affected: number | null;
  truncated: boolean;
}

export interface ExecuteResult {
  results: ResultSet[];
  error: import("./rpc").RpcError | null;
  durationMs: number;
  history?: HistoryEntry;
}

export interface HistoryEntry {
  id: number;
  connectionId: string;
  database: string;
  kind: "sql" | "redis";
  sql: string;
  executedAt: string;
  durationMs: number;
  rows: number | null;
  error: string | null;
}

export interface SavedQuery {
  id: string;
  connectionId: string | null;
  name: string;
  sql: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RedisKey {
  key: string;
  type: string;
  ttlMs: number;
}

export interface RedisScanPage {
  cursor: string;
  keys: RedisKey[];
  dbSize: number;
  done: boolean;
}

export interface RedisInfo {
  sections: Record<string, Record<string, string>>;
  databases: number;
}

export interface RedisValue {
  key: string;
  type: string;
  ttlMs: number;
  length: number;
  memoryBytes: number | null;
  encoding: string | null;
  value: unknown;
  truncated: boolean;
}
