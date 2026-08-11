import { z } from 'zod';

export const REPORT_DATABASE_NAME = 'resume-ai-reports.db';
export const REPORT_SCHEMA_VERSION = 2;
const MIGRATION_LOCK_TABLE = '__resume_ai_report_migration_lock';
const LEGACY_AI_STATUS = 'legacy_feedback_present';

export type ReportSqlValue = string | number | null | boolean | Uint8Array;

export interface ReportSqlExecutor {
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    ...params: ReportSqlValue[]
  ): Promise<Readonly<{ lastInsertRowId: number; changes: number }>>;
  getFirstAsync<T>(source: string, ...params: ReportSqlValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: ReportSqlValue[]): Promise<T[]>;
}

export interface ReportDatabase extends ReportSqlExecutor {
  readonly identity: string;
  withExclusiveTransactionAsync(
    task: (transaction: ReportSqlExecutor) => Promise<void>,
  ): Promise<void>;
  closeAsync(): Promise<void>;
}

const MIGRATION_FLIGHTS = new Map<string, Promise<void>>();

const VERSION_ONE_REPORTS_DDL = `CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  score_json TEXT NOT NULL,
  feedback_json TEXT NOT NULL
)`;

const REPORTS_DDL = `CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  score_json TEXT NOT NULL,
  feedback_json TEXT NOT NULL,
  ai_status TEXT NOT NULL DEFAULT '${LEGACY_AI_STATUS}'
)`;

// SQLite preserves the original CREATE TABLE text and appends an ALTERed
// column immediately before the closing parenthesis. Both forms are exact,
// supported v2 schemas: fresh installs use REPORTS_DDL and v1 upgrades use
// this deterministic SQLite representation.
const MIGRATED_REPORTS_DDL = `${VERSION_ONE_REPORTS_DDL.slice(0, -1)}, ai_status TEXT NOT NULL DEFAULT '${LEGACY_AI_STATUS}')`;

const REPORTS_INDEX_DDL =
  'CREATE INDEX reports_created_id_desc ON reports(created_at DESC, id DESC)';

const METADATA_DDL = `CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

const CREATE_VERSION_TWO_SQL = `${REPORTS_DDL};
${METADATA_DDL};
${REPORTS_INDEX_DDL};`;

const UserVersionRowSchema = z
  .object({ user_version: z.number().int().nonnegative() })
  .strict();

const TableNameRowSchema = z.object({ name: z.string() }).strict();

const ColumnRowSchema = z
  .object({
    cid: z.number().int().nonnegative(),
    name: z.string(),
    type: z.string(),
    notnull: z.number().int().min(0).max(1),
    dflt_value: z.string().nullable(),
    pk: z.number().int().min(0).max(1),
    hidden: z.number().int().min(0).max(3),
  })
  .strict();

const SchemaObjectRowSchema = z
  .object({
    type: z.string(),
    name: z.string(),
    tbl_name: z.string(),
    sql: z.string(),
  })
  .strict();

const MetadataRowSchema = z
  .object({ key: z.string(), value: z.string() })
  .strict();

type ExpectedColumn = Readonly<z.infer<typeof ColumnRowSchema>>;

const EXPECTED_VERSION_ONE_REPORT_COLUMNS: readonly ExpectedColumn[] = Object.freeze([
  { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
  { cid: 1, name: 'schema_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 2, name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 3, name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 4, name: 'source_type', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 5, name: 'score_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 6, name: 'feedback_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
]);

const EXPECTED_REPORT_COLUMNS: readonly ExpectedColumn[] = Object.freeze([
  ...EXPECTED_VERSION_ONE_REPORT_COLUMNS,
  {
    cid: 7,
    name: 'ai_status',
    type: 'TEXT',
    notnull: 1,
    dflt_value: `'${LEGACY_AI_STATUS}'`,
    pk: 0,
    hidden: 0,
  },
]);

const EXPECTED_METADATA_COLUMNS: readonly ExpectedColumn[] = Object.freeze([
  { cid: 0, name: 'key', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
  { cid: 1, name: 'value', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
]);

const EXPECTED_SCHEMA_OBJECTS = Object.freeze([
  {
    type: 'index',
    name: 'reports_created_id_desc',
    tbl_name: 'reports',
    sql: REPORTS_INDEX_DDL,
  },
  { type: 'table', name: 'metadata', tbl_name: 'metadata', sql: METADATA_DDL },
  { type: 'table', name: 'reports', tbl_name: 'reports', sql: REPORTS_DDL },
]);

const EXPECTED_VERSION_ONE_SCHEMA_OBJECTS = Object.freeze([
  { type: 'table', name: 'metadata', tbl_name: 'metadata', sql: METADATA_DDL },
  {
    type: 'table',
    name: 'reports',
    tbl_name: 'reports',
    sql: VERSION_ONE_REPORTS_DDL,
  },
]);

const EXPECTED_MIGRATED_SCHEMA_OBJECTS = Object.freeze([
  EXPECTED_SCHEMA_OBJECTS[0],
  EXPECTED_SCHEMA_OBJECTS[1],
  { type: 'table', name: 'reports', tbl_name: 'reports', sql: MIGRATED_REPORTS_DDL },
]);

function migrationFailure(): Error {
  return new Error('The local report database schema is not supported.');
}

function databaseIdentity(value: unknown): string {
  const parsed = z.string().min(1).max(4_096).safeParse(value);
  if (
    !parsed.success ||
    parsed.data !== parsed.data.trim() ||
    /[\u0000-\u001f\u007f]/u.test(parsed.data)
  ) {
    throw migrationFailure();
  }
  return parsed.data;
}

async function readUserVersion(database: ReportSqlExecutor): Promise<number> {
  const row = UserVersionRowSchema.safeParse(
    await database.getFirstAsync<unknown>('PRAGMA user_version'),
  );
  if (!row.success) throw migrationFailure();
  return row.data.user_version;
}

async function readTableNames(database: ReportSqlExecutor): Promise<string[]> {
  const rows = z.array(TableNameRowSchema).safeParse(
    await database.getAllAsync<unknown>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name",
      MIGRATION_LOCK_TABLE,
    ),
  );
  if (!rows.success) throw migrationFailure();
  return rows.data.map(row => row.name);
}

async function attestColumns(
  database: ReportSqlExecutor,
  table: 'reports' | 'metadata',
  expected: readonly ExpectedColumn[],
): Promise<void> {
  const rows = z.array(ColumnRowSchema).safeParse(
    await database.getAllAsync<unknown>(`PRAGMA table_xinfo('${table}')`),
  );
  if (!rows.success || JSON.stringify(rows.data) !== JSON.stringify(expected)) {
    throw migrationFailure();
  }
}

async function attestTables(database: ReportSqlExecutor): Promise<void> {
  const tables = await readTableNames(database);
  if (JSON.stringify(tables) !== JSON.stringify(['metadata', 'reports'])) {
    throw migrationFailure();
  }
}

async function attestSchemaObjects(
  database: ReportSqlExecutor,
  expected: readonly Readonly<z.infer<typeof SchemaObjectRowSchema>>[],
  alternate?: readonly Readonly<z.infer<typeof SchemaObjectRowSchema>>[],
): Promise<void> {
  const schemaObjects = z.array(SchemaObjectRowSchema).safeParse(
    await database.getAllAsync<unknown>(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY type, name",
      MIGRATION_LOCK_TABLE,
    ),
  );
  if (
    !schemaObjects.success ||
    JSON.stringify(schemaObjects.data) !== JSON.stringify(expected) &&
    (alternate === undefined ||
      JSON.stringify(schemaObjects.data) !== JSON.stringify(alternate))
  ) {
    throw migrationFailure();
  }
}

async function attestMetadata(database: ReportSqlExecutor, version: number): Promise<void> {
  const metadata = z.array(MetadataRowSchema).safeParse(
    await database.getAllAsync<unknown>('SELECT key, value FROM metadata ORDER BY key'),
  );
  if (
    !metadata.success ||
    JSON.stringify(metadata.data) !==
      JSON.stringify([{ key: 'schema_version', value: String(version) }])
  ) {
    throw migrationFailure();
  }
}

async function attestVersionOne(database: ReportSqlExecutor): Promise<void> {
  if (await readUserVersion(database) !== 1) throw migrationFailure();
  await attestTables(database);
  await attestColumns(database, 'reports', EXPECTED_VERSION_ONE_REPORT_COLUMNS);
  await attestColumns(database, 'metadata', EXPECTED_METADATA_COLUMNS);
  await attestSchemaObjects(database, EXPECTED_VERSION_ONE_SCHEMA_OBJECTS);
  await attestMetadata(database, 1);
}

async function attestVersionTwo(database: ReportSqlExecutor): Promise<void> {
  if (await readUserVersion(database) !== REPORT_SCHEMA_VERSION) throw migrationFailure();
  await attestTables(database);

  await attestColumns(database, 'reports', EXPECTED_REPORT_COLUMNS);
  await attestColumns(database, 'metadata', EXPECTED_METADATA_COLUMNS);
  await attestSchemaObjects(
    database,
    EXPECTED_SCHEMA_OBJECTS,
    EXPECTED_MIGRATED_SCHEMA_OBJECTS,
  );
  await attestMetadata(database, REPORT_SCHEMA_VERSION);
}

async function migratePhysicalReportDatabase(database: ReportDatabase): Promise<void> {
  await database.withExclusiveTransactionAsync(async transaction => {
    // Expo SDK 57 starts this separate connection with deferred BEGIN. This
    // main-schema write is intentionally first so no schema read can race a
    // second fresh migration. It is removed before the transaction commits.
    await transaction.execAsync(
      `CREATE TABLE ${MIGRATION_LOCK_TABLE} (id INTEGER PRIMARY KEY)`,
    );
    const userVersion = await readUserVersion(transaction);
    if (userVersion > REPORT_SCHEMA_VERSION) throw migrationFailure();

    const tables = await readTableNames(transaction);
    if (userVersion === 0) {
      if (tables.length !== 0) throw migrationFailure();
      await transaction.execAsync(CREATE_VERSION_TWO_SQL);
      await transaction.runAsync(
        'INSERT INTO metadata (key, value) VALUES (?, ?)',
        'schema_version',
        String(REPORT_SCHEMA_VERSION),
      );
      await transaction.execAsync(`PRAGMA user_version = ${REPORT_SCHEMA_VERSION}`);
    } else if (userVersion === 1) {
      await attestVersionOne(transaction);
      await transaction.execAsync(
        `ALTER TABLE reports ADD COLUMN ai_status TEXT NOT NULL DEFAULT '${LEGACY_AI_STATUS}'`,
      );
      await transaction.execAsync(REPORTS_INDEX_DDL);
      await transaction.runAsync(
        'UPDATE reports SET schema_version = ? WHERE schema_version = ?',
        REPORT_SCHEMA_VERSION,
        1,
      );
      const metadataUpdate = await transaction.runAsync(
        'UPDATE metadata SET value = ? WHERE key = ?',
        String(REPORT_SCHEMA_VERSION),
        'schema_version',
      );
      if (metadataUpdate.changes !== 1) throw migrationFailure();
      await transaction.execAsync(`PRAGMA user_version = ${REPORT_SCHEMA_VERSION}`);
    } else if (userVersion !== REPORT_SCHEMA_VERSION) {
      throw migrationFailure();
    }

    await transaction.execAsync(`DROP TABLE ${MIGRATION_LOCK_TABLE}`);
    await attestVersionTwo(transaction);
  });
}

export function migrateReportDatabase(database: ReportDatabase): Promise<void> {
  let identity: string;
  try {
    identity = databaseIdentity(database.identity);
  } catch {
    return Promise.reject(migrationFailure());
  }

  const inFlight = MIGRATION_FLIGHTS.get(identity);
  if (inFlight !== undefined) return inFlight;

  const migration = Promise.resolve().then(() => migratePhysicalReportDatabase(database));
  MIGRATION_FLIGHTS.set(identity, migration);
  void migration.then(
    () => {
      if (MIGRATION_FLIGHTS.get(identity) === migration) MIGRATION_FLIGHTS.delete(identity);
    },
    () => {
      if (MIGRATION_FLIGHTS.get(identity) === migration) MIGRATION_FLIGHTS.delete(identity);
    },
  );
  return migration;
}
