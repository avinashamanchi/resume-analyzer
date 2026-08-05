// Narrow SQLite boundary fake shared by the Task 12 storage suites.
type Row = Record<string, unknown>;

export type FakeColumn = Readonly<{
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}>;

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
    if (compact.includes('CREATE TABLE reports') && compact.includes('CREATE TABLE metadata')) {
      this.tables = ['metadata', 'reports'];
      this.columns = {
        metadata: clone(METADATA_COLUMNS),
        reports: clone(REPORT_COLUMNS),
      };
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
    if (/FROM sqlite_master/i.test(compact)) {
      return this.tables.slice().sort().map(name => ({ name })) as T[];
    }
    if (/^PRAGMA table_info\('reports'\)$/i.test(compact)) {
      return clone(this.columns.reports ?? []) as T[];
    }
    if (/^PRAGMA table_info\('metadata'\)$/i.test(compact)) {
      return clone(this.columns.metadata ?? []) as T[];
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
