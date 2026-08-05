// Narrow SQLite boundary fake shared by the Task 12 storage suites.
type Row = Record<string, unknown>;

export type FakeColumn = Readonly<{
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden?: number;
}>;

export type FakeSchemaObject = Readonly<{
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}>;

const REPORT_DDL = `CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  score_json TEXT NOT NULL,
  feedback_json TEXT NOT NULL
)`;

const METADATA_DDL = `CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

const MIGRATION_LOCK = '__resume_ai_report_migration_lock';

const REPORT_COLUMNS: readonly FakeColumn[] = Object.freeze([
  { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: 'schema_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 2, name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 3, name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 4, name: 'source_type', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 5, name: 'score_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { cid: 6, name: 'feedback_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
]);

const METADATA_COLUMNS: readonly FakeColumn[] = Object.freeze([
  { cid: 0, name: 'key', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
  { cid: 1, name: 'value', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
]);

function xinfo(columns: readonly FakeColumn[]): readonly FakeColumn[] {
  return columns.map(column => ({ ...column, hidden: column.hidden ?? 0 }));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export class FakeReportDatabase {
  userVersion = 0;
  tables: string[] = [];
  columns: Record<string, readonly FakeColumn[]> = {};
  xcolumns: Record<string, readonly FakeColumn[]> = {};
  schemaObjects: FakeSchemaObject[] = [];
  metadata: Row[] = [];
  rows: Row[] = [];
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  closeCount = 0;
  failCommit = false;
  failClose = false;
  failNext: RegExp | null = null;
  beforeInsert: (() => Promise<void>) | null = null;
  beforeList: (() => Promise<void>) | null = null;

  static versionOne(): FakeReportDatabase {
    const database = new FakeReportDatabase();
    database.installVersionOne();
    return database;
  }

  installVersionOne(): void {
    this.userVersion = 1;
    this.tables = ['metadata', 'reports'];
    this.columns = {
      metadata: clone(METADATA_COLUMNS),
      reports: clone(REPORT_COLUMNS),
    };
    this.xcolumns = {
      metadata: clone(xinfo(METADATA_COLUMNS)),
      reports: clone(xinfo(REPORT_COLUMNS)),
    };
    this.schemaObjects = [
      { type: 'table', name: 'metadata', tbl_name: 'metadata', sql: METADATA_DDL },
      { type: 'table', name: 'reports', tbl_name: 'reports', sql: REPORT_DDL },
    ];
    this.metadata = [{ key: 'schema_version', value: '1' }];
  }

  private assertOpen(): void {
    if (this.closeCount > 0) throw new Error('database closed: private native cause');
  }

  private record(sql: string, params: readonly unknown[]): string {
    this.assertOpen();
    const compact = normalized(sql);
    this.calls.push({ sql: compact, params: [...params] });
    if (this.failNext?.test(compact)) {
      this.failNext = null;
      throw new Error('private sqlite failure includes resume text');
    }
    return compact;
  }

  async execAsync(sql: string): Promise<void> {
    const compact = this.record(sql, []);
    if (compact.startsWith(`CREATE TABLE ${MIGRATION_LOCK}`)) {
      if (this.tables.includes(MIGRATION_LOCK)) throw new Error('migration lock already exists');
      this.tables = [...this.tables, MIGRATION_LOCK].sort();
      this.schemaObjects.push({
        type: 'table',
        name: MIGRATION_LOCK,
        tbl_name: MIGRATION_LOCK,
        sql: `CREATE TABLE ${MIGRATION_LOCK} (id INTEGER PRIMARY KEY)`,
      });
      this.columns[MIGRATION_LOCK] = [
        { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      ];
      this.xcolumns[MIGRATION_LOCK] = xinfo(this.columns[MIGRATION_LOCK]);
    }
    if (compact === `DROP TABLE ${MIGRATION_LOCK}`) {
      this.tables = this.tables.filter(name => name !== MIGRATION_LOCK);
      this.schemaObjects = this.schemaObjects.filter(object => object.name !== MIGRATION_LOCK);
      delete this.columns[MIGRATION_LOCK];
      delete this.xcolumns[MIGRATION_LOCK];
    }
    if (compact.includes('CREATE TABLE reports') && compact.includes('CREATE TABLE metadata')) {
      if (this.tables.includes('reports') || this.tables.includes('metadata')) {
        throw new Error('schema objects already exist');
      }
      this.tables = [...this.tables, 'metadata', 'reports'].sort();
      this.columns = {
        ...this.columns,
        metadata: clone(METADATA_COLUMNS),
        reports: clone(REPORT_COLUMNS),
      };
      this.xcolumns = {
        ...this.xcolumns,
        metadata: clone(xinfo(METADATA_COLUMNS)),
        reports: clone(xinfo(REPORT_COLUMNS)),
      };
      this.schemaObjects = [
        ...this.schemaObjects,
        { type: 'table', name: 'metadata', tbl_name: 'metadata', sql: METADATA_DDL },
        { type: 'table', name: 'reports', tbl_name: 'reports', sql: REPORT_DDL },
      ];
    }
    const pragma = /PRAGMA user_version\s*=\s*(\d+)/i.exec(compact);
    if (pragma !== null) this.userVersion = Number(pragma[1]);
  }

  async runAsync(sql: string, ...params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }> {
    const compact = this.record(sql, params);
    if (/^INSERT INTO metadata/i.test(compact)) {
      const [key, value] = params;
      if (this.metadata.some(row => row.key === key)) throw new Error('duplicate metadata');
      this.metadata.push({ key, value });
      return { lastInsertRowId: 1, changes: 1 };
    }
    if (/^INSERT INTO reports/i.test(compact)) {
      if (this.beforeInsert !== null) await this.beforeInsert();
      const [id, schemaVersion, title, createdAt, sourceType, scoreJson, feedbackJson] = params;
      if (this.rows.some(row => row.id === id)) throw new Error('duplicate private title');
      this.rows.push({
        id,
        schema_version: schemaVersion,
        title,
        created_at: createdAt,
        source_type: sourceType,
        score_json: scoreJson,
        feedback_json: feedbackJson,
      });
      return { lastInsertRowId: this.rows.length, changes: 1 };
    }
    if (/^DELETE FROM reports WHERE id = \?/i.test(compact)) {
      const before = this.rows.length;
      this.rows = this.rows.filter(row => row.id !== params[0]);
      return { lastInsertRowId: 0, changes: before - this.rows.length };
    }
    if (/^DELETE FROM reports$/i.test(compact)) {
      const changes = this.rows.length;
      this.rows = [];
      return { lastInsertRowId: 0, changes };
    }
    throw new Error(`unsupported fake run: ${compact}`);
  }

  async getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    const compact = this.record(sql, params);
    if (/^PRAGMA user_version$/i.test(compact)) {
      return { user_version: this.userVersion } as T;
    }
    if (/^SELECT COUNT\(\*\) AS count FROM reports$/i.test(compact)) {
      return { count: this.rows.length } as T;
    }
    if (/FROM reports WHERE id = \?/i.test(compact)) {
      return (clone(this.rows.find(row => row.id === params[0]) ?? null) as T | null);
    }
    throw new Error(`unsupported fake first: ${compact}`);
  }

  async getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const compact = this.record(sql, params);
    if (/SELECT name FROM sqlite_(?:master|schema)/i.test(compact)) {
      const excluded = typeof params[0] === 'string' ? params[0] : null;
      return this.tables.filter(name => name !== excluded).slice().sort().map(name => ({ name })) as T[];
    }
    if (/SELECT type, name, tbl_name, sql FROM sqlite_schema/i.test(compact)) {
      return clone(this.schemaObjects.slice().sort((left, right) =>
        left.type.localeCompare(right.type) || left.name.localeCompare(right.name)
      )) as T[];
    }
    if (/^PRAGMA table_info\('reports'\)$/i.test(compact)) {
      return clone(this.columns.reports ?? []) as T[];
    }
    if (/^PRAGMA table_info\('metadata'\)$/i.test(compact)) {
      return clone(this.columns.metadata ?? []) as T[];
    }
    if (/^PRAGMA table_xinfo\('reports'\)$/i.test(compact)) {
      return clone(this.xcolumns.reports ?? []) as T[];
    }
    if (/^PRAGMA table_xinfo\('metadata'\)$/i.test(compact)) {
      return clone(this.xcolumns.metadata ?? []) as T[];
    }
    if (/FROM metadata ORDER BY key/i.test(compact)) {
      return clone(this.metadata.slice().sort((left, right) => String(left.key).localeCompare(String(right.key)))) as T[];
    }
    if (/FROM reports ORDER BY created_at DESC, id DESC/i.test(compact)) {
      if (this.beforeList !== null) await this.beforeList();
      return clone(this.rows.slice().sort((left, right) => {
        const byDate = String(right.created_at).localeCompare(String(left.created_at));
        return byDate || String(right.id).localeCompare(String(left.id));
      })) as T[];
    }
    throw new Error(`unsupported fake all: ${compact}`);
  }

  async withExclusiveTransactionAsync(task: (transaction: FakeReportDatabase) => Promise<void>): Promise<void> {
    this.record('BEGIN EXCLUSIVE', []);
    const snapshot = clone({
      userVersion: this.userVersion,
      tables: this.tables,
      columns: this.columns,
      xcolumns: this.xcolumns,
      schemaObjects: this.schemaObjects,
      metadata: this.metadata,
      rows: this.rows,
    });
    try {
      await task(this);
      if (this.failCommit) throw new Error('private commit failure');
      this.calls.push({ sql: 'COMMIT', params: [] });
    } catch (error) {
      this.userVersion = snapshot.userVersion;
      this.tables = snapshot.tables;
      this.columns = snapshot.columns;
      this.xcolumns = snapshot.xcolumns;
      this.schemaObjects = snapshot.schemaObjects;
      this.metadata = snapshot.metadata;
      this.rows = snapshot.rows;
      this.calls.push({ sql: 'ROLLBACK', params: [] });
      throw error;
    }
  }

  async closeAsync(): Promise<void> {
    if (this.closeCount > 0) throw new Error('double close');
    this.closeCount += 1;
    if (this.failClose) throw new Error('private close failure');
  }
}

export const versionOneReportColumns = REPORT_COLUMNS;

type SharedSnapshot = Readonly<{
  userVersion: number;
  tables: string[];
  columns: Record<string, readonly FakeColumn[]>;
  xcolumns: Record<string, readonly FakeColumn[]>;
  schemaObjects: FakeSchemaObject[];
  metadata: Row[];
  rows: Row[];
}>;

function snapshot(database: FakeReportDatabase): SharedSnapshot {
  return clone({
    userVersion: database.userVersion,
    tables: database.tables,
    columns: database.columns,
    xcolumns: database.xcolumns,
    schemaObjects: database.schemaObjects,
    metadata: database.metadata,
    rows: database.rows,
  });
}

function restore(database: FakeReportDatabase, value: SharedSnapshot): void {
  database.userVersion = value.userVersion;
  database.tables = value.tables;
  database.columns = value.columns;
  database.xcolumns = value.xcolumns;
  database.schemaObjects = value.schemaObjects;
  database.metadata = value.metadata;
  database.rows = value.rows;
}

export class SharedDeferredReportStore {
  readonly database = new FakeReportDatabase();
  readonly connections: SharedDeferredReportConnection[] = [];
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  connection(options: { failClose?: boolean; beforeClose?: () => Promise<void> } = {}): SharedDeferredReportConnection {
    const connection = new SharedDeferredReportConnection(this, options);
    this.connections.push(connection);
    return connection;
  }

  async acquire(): Promise<() => void> {
    if (this.locked) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.locked = true;
    return () => {
      const next = this.waiters.shift();
      if (next === undefined) this.locked = false;
      else next();
    };
  }
}

class DeferredTransaction {
  private release: (() => void) | null = null;
  private beforeWrite: SharedSnapshot | null = null;

  constructor(private readonly store: SharedDeferredReportStore) {}

  private async writeLock(): Promise<void> {
    if (this.release !== null) return;
    this.release = await this.store.acquire();
    this.beforeWrite = snapshot(this.store.database);
  }

  async execAsync(sql: string): Promise<void> {
    await this.writeLock();
    await this.store.database.execAsync(sql);
  }

  async runAsync(sql: string, ...params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }> {
    await this.writeLock();
    return this.store.database.runAsync(sql, ...params);
  }

  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    return this.store.database.getFirstAsync<T>(sql, ...params);
  }

  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.store.database.getAllAsync<T>(sql, ...params);
  }

  finish(commit: boolean): void {
    if (!commit && this.beforeWrite !== null) restore(this.store.database, this.beforeWrite);
    this.release?.();
    this.release = null;
  }
}

export class SharedDeferredReportConnection {
  closeCount = 0;

  constructor(
    private readonly store: SharedDeferredReportStore,
    private readonly options: { failClose?: boolean; beforeClose?: () => Promise<void> },
  ) {}

  execAsync(sql: string): Promise<void> {
    return this.store.database.execAsync(sql);
  }

  runAsync(sql: string, ...params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }> {
    return this.store.database.runAsync(sql, ...params);
  }

  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    return this.store.database.getFirstAsync<T>(sql, ...params);
  }

  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.store.database.getAllAsync<T>(sql, ...params);
  }

  async withExclusiveTransactionAsync(task: (transaction: DeferredTransaction) => Promise<void>): Promise<void> {
    this.store.database.calls.push({ sql: 'BEGIN DEFERRED', params: [] });
    const transaction = new DeferredTransaction(this.store);
    try {
      await task(transaction);
      transaction.finish(true);
      this.store.database.calls.push({ sql: 'COMMIT', params: [] });
    } catch (error) {
      transaction.finish(false);
      this.store.database.calls.push({ sql: 'ROLLBACK', params: [] });
      throw error;
    }
  }

  async closeAsync(): Promise<void> {
    this.closeCount += 1;
    await this.options.beforeClose?.();
    if (this.options.failClose) throw new Error('private shared close failure');
  }
}
