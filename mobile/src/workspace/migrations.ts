import { z } from 'zod';

export const WORKSPACE_DATABASE_NAME = 'resume-ai-workspace.db';
export const WORKSPACE_SCHEMA_VERSION = 1;
const MIGRATION_LOCK_TABLE = '__resume_ai_workspace_migration_lock';

export type WorkspaceSqlValue = string | number | null | boolean | Uint8Array;

export interface WorkspaceSqlExecutor {
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    ...params: WorkspaceSqlValue[]
  ): Promise<Readonly<{ lastInsertRowId: number; changes: number }>>;
  getFirstAsync<T>(source: string, ...params: WorkspaceSqlValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: WorkspaceSqlValue[]): Promise<T[]>;
}

export interface WorkspaceDatabase extends WorkspaceSqlExecutor {
  readonly identity: string;
  withExclusiveTransactionAsync(
    task: (transaction: WorkspaceSqlExecutor) => Promise<void>,
  ): Promise<void>;
  closeAsync(): Promise<void>;
}

export const RESUME_VERSIONS_DDL = `CREATE TABLE resume_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  role_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  latest_snapshot_id TEXT NOT NULL
)`;

export const VERSION_SNAPSHOTS_DDL = `CREATE TABLE version_snapshots (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  version_id TEXT NOT NULL REFERENCES resume_versions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  resume_text TEXT NOT NULL,
  score_json TEXT NOT NULL,
  keywords_json TEXT NOT NULL
)`;

export const JOBS_DDL = `CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  company_label TEXT NOT NULL,
  role_label TEXT NOT NULL,
  status TEXT NOT NULL,
  next_action_at TEXT,
  notes TEXT NOT NULL,
  linked_version_id TEXT REFERENCES resume_versions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export const WORKSPACE_METADATA_DDL = `CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

export const VERSION_PAGE_INDEX_DDL =
  'CREATE INDEX resume_versions_updated_id_desc ON resume_versions(updated_at DESC, id DESC)';
export const SNAPSHOT_PAGE_INDEX_DDL =
  'CREATE INDEX version_snapshots_version_created_id_desc ON version_snapshots(version_id, created_at DESC, id DESC)';
export const JOB_PAGE_INDEX_DDL =
  'CREATE INDEX jobs_updated_id_desc ON jobs(updated_at DESC, id DESC)';

const CREATE_SCHEMA_SQL = `${RESUME_VERSIONS_DDL};
${VERSION_SNAPSHOTS_DDL};
${JOBS_DDL};
${WORKSPACE_METADATA_DDL};
${VERSION_PAGE_INDEX_DDL};
${SNAPSHOT_PAGE_INDEX_DDL};
${JOB_PAGE_INDEX_DDL};`;

const EXPECTED_SCHEMA_OBJECTS = Object.freeze([
  { type: 'index', name: 'jobs_updated_id_desc', tbl_name: 'jobs', sql: JOB_PAGE_INDEX_DDL },
  {
    type: 'index',
    name: 'resume_versions_updated_id_desc',
    tbl_name: 'resume_versions',
    sql: VERSION_PAGE_INDEX_DDL,
  },
  {
    type: 'index',
    name: 'version_snapshots_version_created_id_desc',
    tbl_name: 'version_snapshots',
    sql: SNAPSHOT_PAGE_INDEX_DDL,
  },
  { type: 'table', name: 'jobs', tbl_name: 'jobs', sql: JOBS_DDL },
  { type: 'table', name: 'metadata', tbl_name: 'metadata', sql: WORKSPACE_METADATA_DDL },
  {
    type: 'table',
    name: 'resume_versions',
    tbl_name: 'resume_versions',
    sql: RESUME_VERSIONS_DDL,
  },
  {
    type: 'table',
    name: 'version_snapshots',
    tbl_name: 'version_snapshots',
    sql: VERSION_SNAPSHOTS_DDL,
  },
]);

const MIGRATION_FLIGHTS = new Map<string, Promise<void>>();
const UserVersionSchema = z.object({ user_version: z.number().int().nonnegative() }).strict();
const ForeignKeysSchema = z.object({ foreign_keys: z.union([z.literal(0), z.literal(1)]) }).strict();
const NameSchema = z.object({ name: z.string() }).strict();
const SchemaObjectSchema = z.object({
  type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string(),
}).strict();
const MetadataSchema = z.object({ key: z.string(), value: z.string() }).strict();

function failure(): Error {
  return new Error('The local career workspace schema is not supported.');
}

function validIdentity(value: unknown): string {
  const parsed = z.string().min(1).max(4_096).safeParse(value);
  if (
    !parsed.success ||
    parsed.data !== parsed.data.trim() ||
    /[\u0000-\u001f\u007f]/u.test(parsed.data)
  ) throw failure();
  return parsed.data;
}

async function userVersion(database: WorkspaceSqlExecutor): Promise<number> {
  const value = UserVersionSchema.safeParse(
    await database.getFirstAsync<unknown>('PRAGMA user_version'),
  );
  if (!value.success) throw failure();
  return value.data.user_version;
}

async function tableNames(database: WorkspaceSqlExecutor): Promise<string[]> {
  const value = z.array(NameSchema).safeParse(await database.getAllAsync<unknown>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name",
    MIGRATION_LOCK_TABLE,
  ));
  if (!value.success) throw failure();
  return value.data.map(item => item.name);
}

async function attest(database: WorkspaceSqlExecutor): Promise<void> {
  if (await userVersion(database) !== WORKSPACE_SCHEMA_VERSION) throw failure();
  const foreignKeys = ForeignKeysSchema.safeParse(
    await database.getFirstAsync<unknown>('PRAGMA foreign_keys'),
  );
  if (!foreignKeys.success || foreignKeys.data.foreign_keys !== 1) throw failure();
  if (JSON.stringify(await tableNames(database)) !== JSON.stringify([
    'jobs', 'metadata', 'resume_versions', 'version_snapshots',
  ])) throw failure();

  const objects = z.array(SchemaObjectSchema).safeParse(await database.getAllAsync<unknown>(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY type, name",
    MIGRATION_LOCK_TABLE,
  ));
  if (
    !objects.success ||
    JSON.stringify(objects.data) !== JSON.stringify(EXPECTED_SCHEMA_OBJECTS)
  ) throw failure();

  const metadata = z.array(MetadataSchema).safeParse(
    await database.getAllAsync<unknown>('SELECT key, value FROM metadata ORDER BY key'),
  );
  if (
    !metadata.success ||
    JSON.stringify(metadata.data) !== JSON.stringify([
      { key: 'schema_version', value: String(WORKSPACE_SCHEMA_VERSION) },
    ])
  ) throw failure();
}

async function migratePhysical(database: WorkspaceDatabase): Promise<void> {
  await database.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(
      `CREATE TABLE ${MIGRATION_LOCK_TABLE} (id INTEGER PRIMARY KEY)`,
    );
    const version = await userVersion(transaction);
    if (version > WORKSPACE_SCHEMA_VERSION) throw failure();
    const tables = await tableNames(transaction);
    if (version === 0) {
      if (tables.length !== 0) throw failure();
      await transaction.execAsync(CREATE_SCHEMA_SQL);
      await transaction.runAsync(
        'INSERT INTO metadata (key, value) VALUES (?, ?)',
        'schema_version',
        String(WORKSPACE_SCHEMA_VERSION),
      );
      await transaction.execAsync(`PRAGMA user_version = ${WORKSPACE_SCHEMA_VERSION}`);
    } else if (version !== WORKSPACE_SCHEMA_VERSION) {
      throw failure();
    }
    await transaction.execAsync(`DROP TABLE ${MIGRATION_LOCK_TABLE}`);
    await attest(transaction);
  });
}

export async function migrateWorkspaceDatabase(database: WorkspaceDatabase): Promise<void> {
  const identity = validIdentity(database.identity);
  await database.execAsync('PRAGMA foreign_keys = ON');
  const existing = MIGRATION_FLIGHTS.get(identity);
  if (existing !== undefined) return existing;
  const migration = Promise.resolve().then(() => migratePhysical(database));
  MIGRATION_FLIGHTS.set(identity, migration);
  void migration.finally(() => {
    if (MIGRATION_FLIGHTS.get(identity) === migration) MIGRATION_FLIGHTS.delete(identity);
  }).catch(() => undefined);
  return migration;
}
