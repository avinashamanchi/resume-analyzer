import {
  JOBS_DDL,
  JOB_PAGE_INDEX_DDL,
  RESUME_VERSIONS_DDL,
  SNAPSHOT_PAGE_INDEX_DDL,
  VERSION_PAGE_INDEX_DDL,
  VERSION_SNAPSHOTS_DDL,
  WORKSPACE_METADATA_DDL,
  type WorkspaceDatabase,
  type WorkspaceSqlExecutor,
  type WorkspaceSqlValue,
} from '../src/workspace/migrations';
import { WORKSPACE_DATABASE_IDENTITY } from '../src/workspace/workspaceRepository';

type Row = Record<string, unknown>;
type SchemaObject = Readonly<{ type: string; name: string; tbl_name: string; sql: string }>;

const MIGRATION_LOCK = '__resume_ai_workspace_migration_lock';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function ordered<T extends Row>(rows: readonly T[], field = 'updated_at'): T[] {
  return rows.slice().sort((left, right) => {
    const timestamp = String(right[field]).localeCompare(String(left[field]));
    return timestamp || String(right.id).localeCompare(String(left.id));
  });
}

export class FakeWorkspaceDatabase implements WorkspaceDatabase {
  readonly identity: string;
  userVersion = 0;
  foreignKeys = false;
  tables: string[] = [];
  schemaObjects: SchemaObject[] = [];
  metadata: Row[] = [];
  versions: Row[] = [];
  snapshots: Row[] = [];
  jobs: Row[] = [];
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  failNext: RegExp | null = null;
  failCommit = false;
  closeCount = 0;

  constructor(identity = WORKSPACE_DATABASE_IDENTITY) {
    this.identity = identity;
  }

  private record(source: string, params: readonly unknown[]): string {
    if (this.closeCount > 0) throw new Error('closed workspace database');
    const sql = normalized(source);
    this.calls.push({ sql, params: [...params] });
    if (this.failNext?.test(sql)) {
      this.failNext = null;
      throw new Error('private workspace sqlite failure');
    }
    return sql;
  }

  async execAsync(source: string): Promise<void> {
    const sql = this.record(source, []);
    if (/^PRAGMA foreign_keys = ON$/i.test(sql)) this.foreignKeys = true;
    if (sql.startsWith(`CREATE TABLE ${MIGRATION_LOCK}`)) {
      if (this.tables.includes(MIGRATION_LOCK)) throw new Error('migration lock exists');
      this.tables = [...this.tables, MIGRATION_LOCK].sort();
      this.schemaObjects.push({
        type: 'table', name: MIGRATION_LOCK, tbl_name: MIGRATION_LOCK,
        sql: `CREATE TABLE ${MIGRATION_LOCK} (id INTEGER PRIMARY KEY)`,
      });
    }
    if (sql === `DROP TABLE ${MIGRATION_LOCK}`) {
      this.tables = this.tables.filter(name => name !== MIGRATION_LOCK);
      this.schemaObjects = this.schemaObjects.filter(object => object.name !== MIGRATION_LOCK);
    }
    if (sql.includes('CREATE TABLE resume_versions') && sql.includes('CREATE TABLE jobs')) {
      if (this.tables.some(name => name !== MIGRATION_LOCK)) throw new Error('workspace schema exists');
      this.tables = [...this.tables, 'jobs', 'metadata', 'resume_versions', 'version_snapshots'].sort();
      this.schemaObjects.push(
        { type: 'table', name: 'resume_versions', tbl_name: 'resume_versions', sql: RESUME_VERSIONS_DDL },
        { type: 'table', name: 'version_snapshots', tbl_name: 'version_snapshots', sql: VERSION_SNAPSHOTS_DDL },
        { type: 'table', name: 'jobs', tbl_name: 'jobs', sql: JOBS_DDL },
        { type: 'table', name: 'metadata', tbl_name: 'metadata', sql: WORKSPACE_METADATA_DDL },
        { type: 'index', name: 'resume_versions_updated_id_desc', tbl_name: 'resume_versions', sql: VERSION_PAGE_INDEX_DDL },
        { type: 'index', name: 'version_snapshots_version_created_id_desc', tbl_name: 'version_snapshots', sql: SNAPSHOT_PAGE_INDEX_DDL },
        { type: 'index', name: 'jobs_updated_id_desc', tbl_name: 'jobs', sql: JOB_PAGE_INDEX_DDL },
      );
    }
    const pragma = /^PRAGMA user_version = (\d+)$/i.exec(sql);
    if (pragma !== null) this.userVersion = Number(pragma[1]);
  }

  async runAsync(
    source: string,
    ...params: WorkspaceSqlValue[]
  ): Promise<{ lastInsertRowId: number; changes: number }> {
    const sql = this.record(source, params);
    if (/^INSERT INTO metadata/i.test(sql)) {
      this.metadata.push({ key: params[0], value: params[1] });
      return { lastInsertRowId: 1, changes: 1 };
    }
    if (/^INSERT INTO resume_versions/i.test(sql)) {
      const [id, schemaVersion, title, roleLabel, createdAt, updatedAt, latestSnapshotId] = params;
      if (this.versions.some(row => row.id === id)) throw new Error('duplicate version');
      this.versions.push({
        id, schema_version: schemaVersion, title, role_label: roleLabel,
        created_at: createdAt, updated_at: updatedAt, latest_snapshot_id: latestSnapshotId,
      });
      return { lastInsertRowId: this.versions.length, changes: 1 };
    }
    if (/^INSERT INTO version_snapshots/i.test(sql)) {
      const [id, schemaVersion, versionId, createdAt, resumeText, scoreJson, keywordsJson] = params;
      if (!this.versions.some(row => row.id === versionId)) throw new Error('missing version');
      if (this.snapshots.some(row => row.id === id)) throw new Error('duplicate snapshot');
      this.snapshots.push({
        id, schema_version: schemaVersion, version_id: versionId, created_at: createdAt,
        resume_text: resumeText, score_json: scoreJson, keywords_json: keywordsJson,
      });
      return { lastInsertRowId: this.snapshots.length, changes: 1 };
    }
    if (/^UPDATE resume_versions SET latest_snapshot_id/i.test(sql)) {
      const [snapshotId, updatedAt, id] = params;
      const row = this.versions.find(item => item.id === id);
      if (row === undefined) return { lastInsertRowId: 0, changes: 0 };
      row.latest_snapshot_id = snapshotId;
      row.updated_at = updatedAt;
      return { lastInsertRowId: 0, changes: 1 };
    }
    if (/^INSERT INTO jobs/i.test(sql)) {
      const [
        id, schemaVersion, companyLabel, roleLabel, status, nextActionAt, notes,
        linkedVersionId, createdAt, updatedAt,
      ] = params;
      if (this.jobs.some(row => row.id === id)) throw new Error('duplicate job');
      this.jobs.push({
        id, schema_version: schemaVersion, company_label: companyLabel, role_label: roleLabel,
        status, next_action_at: nextActionAt, notes, linked_version_id: linkedVersionId,
        created_at: createdAt, updated_at: updatedAt,
      });
      return { lastInsertRowId: this.jobs.length, changes: 1 };
    }
    if (/^UPDATE jobs SET company_label/i.test(sql)) {
      const [companyLabel, roleLabel, status, nextActionAt, notes, linkedVersionId, updatedAt, id] = params;
      const row = this.jobs.find(item => item.id === id);
      if (row === undefined) return { lastInsertRowId: 0, changes: 0 };
      Object.assign(row, {
        company_label: companyLabel, role_label: roleLabel, status,
        next_action_at: nextActionAt, notes, linked_version_id: linkedVersionId,
        updated_at: updatedAt,
      });
      return { lastInsertRowId: 0, changes: 1 };
    }
    if (/^UPDATE jobs SET linked_version_id = NULL/i.test(sql)) {
      let changes = 0;
      for (const row of this.jobs) {
        if (row.linked_version_id !== params[0]) continue;
        row.linked_version_id = null;
        changes += 1;
      }
      return { lastInsertRowId: 0, changes };
    }
    if (/^DELETE FROM version_snapshots WHERE version_id = \?/i.test(sql)) {
      const before = this.snapshots.length;
      this.snapshots = this.snapshots.filter(row => row.version_id !== params[0]);
      return { lastInsertRowId: 0, changes: before - this.snapshots.length };
    }
    if (/^DELETE FROM resume_versions WHERE id = \?/i.test(sql)) {
      const before = this.versions.length;
      this.versions = this.versions.filter(row => row.id !== params[0]);
      return { lastInsertRowId: 0, changes: before - this.versions.length };
    }
    if (/^DELETE FROM jobs WHERE id = \?/i.test(sql)) {
      const before = this.jobs.length;
      this.jobs = this.jobs.filter(row => row.id !== params[0]);
      return { lastInsertRowId: 0, changes: before - this.jobs.length };
    }
    if (sql === 'DELETE FROM jobs') {
      const changes = this.jobs.length;
      this.jobs = [];
      return { lastInsertRowId: 0, changes };
    }
    if (sql === 'DELETE FROM version_snapshots') {
      const changes = this.snapshots.length;
      this.snapshots = [];
      return { lastInsertRowId: 0, changes };
    }
    if (sql === 'DELETE FROM resume_versions') {
      const changes = this.versions.length;
      this.versions = [];
      return { lastInsertRowId: 0, changes };
    }
    throw new Error(`unsupported workspace run: ${sql}`);
  }

  async getFirstAsync<T>(source: string, ...params: WorkspaceSqlValue[]): Promise<T | null> {
    const sql = this.record(source, params);
    if (sql === 'PRAGMA user_version') return { user_version: this.userVersion } as T;
    if (sql === 'PRAGMA foreign_keys') return { foreign_keys: this.foreignKeys ? 1 : 0 } as T;
    if (/^SELECT COUNT\(\*\) AS count FROM resume_versions$/i.test(sql)) {
      return { count: this.versions.length } as T;
    }
    if (/^SELECT COUNT\(\*\) AS count FROM jobs$/i.test(sql)) {
      return { count: this.jobs.length } as T;
    }
    if (/^SELECT COUNT\(\*\) AS count FROM version_snapshots$/i.test(sql)) {
      return { count: this.snapshots.length } as T;
    }
    if (/^SELECT COUNT\(\*\) AS count FROM version_snapshots WHERE version_id = \?/i.test(sql)) {
      return { count: this.snapshots.filter(row => row.version_id === params[0]).length } as T;
    }
    if (/^SELECT id FROM resume_versions WHERE id = \?/i.test(sql)) {
      const row = this.versions.find(item => item.id === params[0]);
      return (row === undefined ? null : { id: row.id }) as T | null;
    }
    if (/FROM resume_versions WHERE id = \?/i.test(sql)) {
      return clone(this.versions.find(row => row.id === params[0]) ?? null) as T | null;
    }
    if (/FROM jobs WHERE id = \?/i.test(sql)) {
      return clone(this.jobs.find(row => row.id === params[0]) ?? null) as T | null;
    }
    throw new Error(`unsupported workspace first: ${sql}`);
  }

  async getAllAsync<T>(source: string, ...params: WorkspaceSqlValue[]): Promise<T[]> {
    const sql = this.record(source, params);
    if (/SELECT name FROM sqlite_schema/i.test(sql)) {
      const excluded = typeof params[0] === 'string' ? params[0] : null;
      return this.tables.filter(name => name !== excluded).slice().sort()
        .map(name => ({ name })) as T[];
    }
    if (/SELECT type, name, tbl_name, sql FROM sqlite_schema/i.test(sql)) {
      const excluded = typeof params[0] === 'string' ? params[0] : null;
      return clone(this.schemaObjects.filter(object => object.name !== excluded).slice().sort(
        (left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name),
      )) as T[];
    }
    if (/FROM metadata ORDER BY key/i.test(sql)) {
      return clone(this.metadata.slice().sort(
        (left, right) => String(left.key).localeCompare(String(right.key)),
      )) as T[];
    }
    if (sql.includes('FROM resume_versions') && sql.includes('ORDER BY updated_at DESC, id DESC')) {
      let rows = ordered(this.versions);
      if (sql.includes('WHERE (updated_at < ? OR (updated_at = ? AND id < ?))')) {
        rows = rows.filter(row =>
          String(row.updated_at) < String(params[0]) ||
          (String(row.updated_at) === String(params[1]) && String(row.id) < String(params[2]))
        );
      }
      return clone(rows.slice(0, Number(params.at(-1)))) as T[];
    }
    if (sql.includes('FROM version_snapshots WHERE version_id = ?')) {
      const rows = ordered(
        this.snapshots.filter(row => row.version_id === params[0]),
        'created_at',
      );
      return clone(rows.slice(0, Number(params[1]))) as T[];
    }
    if (sql.includes('FROM jobs') && sql.includes('ORDER BY updated_at DESC, id DESC')) {
      let rows = ordered(this.jobs);
      if (sql.includes('WHERE (updated_at < ? OR (updated_at = ? AND id < ?))')) {
        rows = rows.filter(row =>
          String(row.updated_at) < String(params[0]) ||
          (String(row.updated_at) === String(params[1]) && String(row.id) < String(params[2]))
        );
      }
      return clone(rows.slice(0, Number(params.at(-1)))) as T[];
    }
    throw new Error(`unsupported workspace all: ${sql}`);
  }

  async withExclusiveTransactionAsync(
    task: (transaction: WorkspaceSqlExecutor) => Promise<void>,
  ): Promise<void> {
    this.record('BEGIN EXCLUSIVE', []);
    const snapshot = clone({
      userVersion: this.userVersion,
      tables: this.tables,
      schemaObjects: this.schemaObjects,
      metadata: this.metadata,
      versions: this.versions,
      snapshots: this.snapshots,
      jobs: this.jobs,
    });
    try {
      await task(this);
      if (this.failCommit) throw new Error('private workspace commit failure');
      this.calls.push({ sql: 'COMMIT', params: [] });
    } catch (error) {
      this.userVersion = snapshot.userVersion;
      this.tables = snapshot.tables;
      this.schemaObjects = snapshot.schemaObjects;
      this.metadata = snapshot.metadata;
      this.versions = snapshot.versions;
      this.snapshots = snapshot.snapshots;
      this.jobs = snapshot.jobs;
      this.calls.push({ sql: 'ROLLBACK', params: [] });
      throw error;
    }
  }

  async closeAsync(): Promise<void> {
    if (this.closeCount > 0) throw new Error('workspace double close');
    this.closeCount += 1;
  }
}
