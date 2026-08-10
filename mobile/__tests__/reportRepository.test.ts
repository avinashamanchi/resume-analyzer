import validFixture from '../../contracts/fixtures/analysis-valid.json';

import type { AnalysisResponse } from '../src/domain/contracts';
import {
  TempFileRegistry,
  type AbandonedCleanupReceipt,
  type CleanupReceipt,
  type DirectoryEntry,
  type FileInspection,
  type TempFileSystem,
} from '../src/documents/tempFileRegistry';
import {
  LocalStorageError,
  ReportRepository,
  type ReportRecord,
} from '../src/storage/reportRepository';

import {
  FakeReportDatabase,
  ImmediateBusyReportStore,
  versionTwoReportColumns,
} from '../test-utils/fakeReportDatabase';

const FIRST_ID = '8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b';
const SECOND_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CLEAN: CleanupReceipt = { attempted: 0, deleted: 0, failed: 0, refused: 0 };
const DETAILED_CLEAN: AbandonedCleanupReceipt = {
  ...CLEAN,
  deletedFiles: 0,
  live: 0,
};
const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FILE_A = '11111111-1111-4111-8111-111111111111';
const CACHE_NAMESPACE = 'file:///app/cache/resume-ai-v1';

class LiveCacheFileSystem implements TempFileSystem {
  readonly cacheDirectoryUri = 'file:///app/cache/';
  readonly directories = new Set<string>();
  readonly files = new Set<string>();
  readonly deleted: string[] = [];

  async createDirectory(uri: string): Promise<void> {
    this.directories.add(uri);
  }

  async directoryExists(uri: string): Promise<boolean> {
    return this.directories.has(uri);
  }

  async listDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    if (uri === CACHE_NAMESPACE) {
      return [...this.directories]
        .filter(candidate => candidate.startsWith(`${CACHE_NAMESPACE}/`))
        .map(candidate => ({ uri: candidate, kind: 'directory' as const }));
    }
    return [...this.files]
      .filter(candidate => candidate.startsWith(`${uri}/`))
      .map(candidate => ({ uri: candidate, kind: 'file' as const }));
  }

  async copyFile(_source: string, destination: string): Promise<void> {
    this.files.add(destination);
  }

  async inspectFile(uri: string): Promise<FileInspection> {
    return {
      exists: this.files.has(uri),
      size: 128,
      header: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    };
  }

  async deleteDirectory(uri: string): Promise<void> {
    this.deleted.push(uri);
    this.directories.delete(uri);
    for (const file of [...this.files]) {
      if (file.startsWith(`${uri}/`)) this.files.delete(file);
    }
  }
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function result(id = FIRST_ID): AnalysisResponse {
  return { ...copy(validFixture), analysisId: id } as AnalysisResponse;
}

function v2Result(
  id: string,
  aiStatus: 'complete' | 'temporarily_unavailable' = 'complete',
) {
  const complete = aiStatus === 'complete';
  return {
    schemaVersion: 2 as const,
    analysisId: id,
    sourceType: 'reviewed_text' as const,
    score: copy(validFixture.score),
    aiStatus,
    feedback: complete ? copy(validFixture.feedback) : null,
    allowance: {
      used: 1,
      limit: 3 as const,
      resetsAt: '2099-09-01T00:00:00Z',
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function harness(options: {
  database?: FakeReportDatabase;
  cleanup?: () => Promise<unknown>;
  now?: () => Date;
  cleanupTimeoutMs?: number;
} = {}) {
  const database = options.database ?? new FakeReportDatabase();
  const cleanupAbandoned = jest.fn(async () =>
    (await (options.cleanup ?? (async () => DETAILED_CLEAN))()) as AbandonedCleanupReceipt
  );
  const openDatabase = jest.fn(async () => database);
  const repository = new ReportRepository({
    openDatabase,
    tempFiles: { cleanupAbandonedDetailed: cleanupAbandoned },
    now: options.now ?? (() => new Date('2026-08-05T19:20:30.000Z')),
    cleanupTimeoutMs: options.cleanupTimeoutMs,
  });
  return { cleanupAbandoned, database, openDatabase, repository };
}

function expectLocalStorageError(error: unknown): void {
  expect(error).toBeInstanceOf(LocalStorageError);
  expect(error).toMatchObject({ category: 'local_storage' });
  expect(String(error)).toBe('LocalStorageError: Local report storage could not complete the operation.');
}

describe('report schema migration', () => {
  it('migrates version-one feedback to an explicit legacy state without fabricating v2 AI completion', async () => {
    const database = FakeReportDatabase.versionOne();
    database.rows.push({
      id: FIRST_ID,
      schema_version: 1,
      title: 'Legacy report',
      created_at: '2026-08-05T19:20:30.000Z',
      source_type: 'text',
      score_json: JSON.stringify(validFixture.score),
      feedback_json: JSON.stringify(validFixture.feedback),
    });
    const { repository } = harness({ database });

    await repository.initialize();

    expect(database.userVersion).toBe(2);
    expect(database.metadata).toEqual([{ key: 'schema_version', value: '2' }]);
    expect(database.rows[0]).toMatchObject({
      schema_version: 2,
      ai_status: 'legacy_feedback_present',
    });
    expect(database.schemaObjects).toContainEqual(expect.objectContaining({
      type: 'index',
      name: 'reports_created_id_desc',
    }));
    await expect((repository as any).get(FIRST_ID)).resolves.toMatchObject({
      aiStatus: 'legacy_feedback_present',
      feedback: validFixture.feedback,
    });
  });

  it('single-flights distinct handles for one physical database before an immediate busy write', async () => {
    const store = new ImmediateBusyReportStore(
      'file:///app/sqlite/reports.db',
      { holdFirstWriter: true },
    );
    const first = new ReportRepository({
      databaseIdentity: store.identity,
      openDatabase: async () => store.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });
    const second = new ReportRepository({
      databaseIdentity: store.identity,
      openDatabase: async () => store.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });

    const firstInitialization = first.initialize();
    await store.firstWriterStarted;
    const joined = Promise.all([firstInitialization, second.initialize()]);
    store.releaseFirstWriter();

    await expect(joined).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(store.writerAttempts).toBe(1);
    expect(store.database.userVersion).toBe(2);
    expect(store.database.tables).toEqual(['metadata', 'reports']);

    const afterSuccess = new ReportRepository({
      databaseIdentity: store.identity,
      openDatabase: async () => store.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });
    await expect(afterSuccess.initialize()).resolves.toBeUndefined();
    expect(store.writerAttempts).toBe(2);
  });

  it('clears a failed physical-database single-flight so a later initialization can retry', async () => {
    const store = new ImmediateBusyReportStore(
      'file:///app/sqlite/retry.db',
      { holdFirstWriter: true },
    );
    store.database.failNext = /^CREATE TABLE __resume_ai_report_migration_lock/;
    const first = new ReportRepository({
      databaseIdentity: store.identity,
      openDatabase: async () => store.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });
    const second = new ReportRepository({
      databaseIdentity: store.identity,
      openDatabase: async () => store.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });

    const firstInitialization = first.initialize();
    await store.firstWriterStarted;
    const joined = Promise.allSettled([firstInitialization, second.initialize()]);
    store.releaseFirstWriter();
    await expect(joined).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(store.writerAttempts).toBe(1);

    const retry = new ReportRepository({
      databaseIdentity: store.identity,
      openDatabase: async () => store.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });
    await expect(retry.initialize()).resolves.toBeUndefined();
    expect(store.writerAttempts).toBe(2);
    expect(store.database.userVersion).toBe(2);
  });

  it('does not serialize migrations for different physical database identities', async () => {
    const firstStore = new ImmediateBusyReportStore(
      'file:///app/sqlite/first.db',
      { holdFirstWriter: true },
    );
    const secondStore = new ImmediateBusyReportStore(
      'file:///app/sqlite/second.db',
      { holdFirstWriter: true },
    );
    const first = new ReportRepository({
      databaseIdentity: firstStore.identity,
      openDatabase: async () => firstStore.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });
    const second = new ReportRepository({
      databaseIdentity: secondStore.identity,
      openDatabase: async () => secondStore.connection(),
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });

    const firstInitialization = first.initialize();
    await firstStore.firstWriterStarted;
    const secondInitialization = second.initialize();
    await expect(Promise.race([
      secondStore.firstWriterStarted.then(() => 'started'),
      new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 25)),
    ])).resolves.toBe('started');
    firstStore.releaseFirstWriter();
    secondStore.releaseFirstWriter();

    await expect(Promise.all([firstInitialization, secondInitialization])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it('creates exact version-two tables and paging index inside an exclusive transaction', async () => {
    const { database, repository } = harness();

    await repository.initialize();

    expect(database.userVersion).toBe(2);
    expect(database.tables).toEqual(['metadata', 'reports']);
    expect(database.columns.reports).toEqual(versionTwoReportColumns);
    expect(database.metadata).toEqual([{ key: 'schema_version', value: '2' }]);
    expect(database.schemaObjects).toContainEqual(expect.objectContaining({
      type: 'index',
      name: 'reports_created_id_desc',
    }));
    expect(database.calls[0]?.sql).toBe('BEGIN EXCLUSIVE');
    expect(database.calls.filter(call => call.sql === 'BEGIN EXCLUSIVE')).toHaveLength(1);
  });

  it('migrates once and then initializes idempotently without reopening', async () => {
    const database = FakeReportDatabase.versionOne();
    const { openDatabase, repository } = harness({ database });

    await Promise.all([repository.initialize(), repository.initialize()]);

    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(database.calls.filter(call => call.sql === 'BEGIN EXCLUSIVE')).toHaveLength(1);
    expect(database.calls.some(call => /^INSERT INTO metadata/.test(call.sql))).toBe(false);
  });

  it.each([
    ['future user version', () => { const db = FakeReportDatabase.versionOne(); db.userVersion = 3; return db; }],
    ['future metadata version', () => { const db = FakeReportDatabase.versionOne(); db.metadata[0] = { key: 'schema_version', value: '3' }; return db; }],
    ['unexpected table', () => { const db = FakeReportDatabase.versionOne(); db.tables.push('private_drafts'); return db; }],
    ['missing column', () => { const db = FakeReportDatabase.versionOne(); db.xcolumns.reports = db.xcolumns.reports.slice(0, -1); return db; }],
    ['extra column', () => { const db = FakeReportDatabase.versionOne(); db.xcolumns.reports = [...db.xcolumns.reports, { cid: 7, name: 'resume_text', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0, hidden: 0 }]; return db; }],
    ['changed column declaration', () => { const db = FakeReportDatabase.versionOne(); db.xcolumns.reports = db.xcolumns.reports.map(column => column.name === 'title' ? { ...column, notnull: 0 } : column); return db; }],
    ['unexpected metadata', () => { const db = FakeReportDatabase.versionOne(); db.metadata.push({ key: 'request_id', value: FIRST_ID }); return db; }],
    ['version-zero legacy table', () => { const db = new FakeReportDatabase(); db.tables = ['reports']; return db; }],
  ])('fails closed for %s without destructive downgrade', async (_name, createDatabase) => {
    const database = createDatabase();
    const original = copy({ tables: database.tables, rows: database.rows, metadata: database.metadata });
    const { repository } = harness({ database });

    const error = await repository.initialize().catch(reason => reason as unknown);
    expectLocalStorageError(error);
    expect({ tables: database.tables, rows: database.rows, metadata: database.metadata }).toEqual(original);
  });

  it.each([
    ['stored generated column', () => {
      const db = FakeReportDatabase.versionOne();
      db.xcolumns.reports = [...db.xcolumns.reports, {
        cid: 7,
        name: 'private_generated',
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
        pk: 0,
        hidden: 3,
      }];
      return db;
    }],
    ['trigger', () => {
      const db = FakeReportDatabase.versionOne();
      db.schemaObjects.push({
        type: 'trigger',
        name: 'private_trigger',
        tbl_name: 'reports',
        sql: 'CREATE TRIGGER private_trigger AFTER INSERT ON reports BEGIN SELECT 1; END',
      });
      return db;
    }],
    ['view', () => {
      const db = FakeReportDatabase.versionOne();
      db.schemaObjects.push({
        type: 'view',
        name: 'private_view',
        tbl_name: 'private_view',
        sql: 'CREATE VIEW private_view AS SELECT * FROM reports',
      });
      return db;
    }],
    ['explicit index', () => {
      const db = FakeReportDatabase.versionOne();
      db.schemaObjects.push({
        type: 'index',
        name: 'private_index',
        tbl_name: 'reports',
        sql: 'CREATE INDEX private_index ON reports(title)',
      });
      return db;
    }],
    ['altered table constraint', () => {
      const db = FakeReportDatabase.versionOne();
      db.schemaObjects = db.schemaObjects.map(object => object.name === 'reports'
        ? { ...object, sql: `${object.sql} STRICT` }
        : object);
      return db;
    }],
  ])('rejects schema attestation with an unexpected %s', async (_name, createDatabase) => {
    const { repository } = harness({ database: createDatabase() });

    await expect(repository.initialize()).rejects.toMatchObject({ category: 'local_storage' });
  });
});

describe('report projection reads and writes', () => {
  it('stores and reopens complete and degraded v2 reviewed-text results truthfully', async () => {
    const { repository } = harness();
    await repository.initialize();

    await expect(repository.save({ result: v2Result(FIRST_ID) })).resolves.toMatchObject({
      id: FIRST_ID,
      sourceType: 'reviewed_text',
      aiStatus: 'complete',
      feedback: validFixture.feedback,
    });
    await expect(repository.save({
      result: v2Result(SECOND_ID, 'temporarily_unavailable'),
    })).resolves.toMatchObject({
      id: SECOND_ID,
      aiStatus: 'temporarily_unavailable',
      feedback: null,
    });

    await expect(repository.get(FIRST_ID)).resolves.toMatchObject({
      aiStatus: 'complete',
      feedback: validFixture.feedback,
    });
    await expect(repository.get(SECOND_ID)).resolves.toMatchObject({
      aiStatus: 'temporarily_unavailable',
      feedback: null,
    });
  });

  it('uses a stable strict keyset and never returns more than the requested page', async () => {
    const database = FakeReportDatabase.versionOne();
    for (let index = 0; index < 53; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      database.rows.push({
        id,
        schema_version: 1,
        title: `Report ${index}`,
        created_at: index < 27
          ? '2026-08-06T19:20:30.000Z'
          : '2026-08-05T19:20:30.000Z',
        source_type: 'text',
        score_json: JSON.stringify(validFixture.score),
        feedback_json: JSON.stringify(validFixture.feedback),
      });
    }
    const { repository } = harness({ database });
    await repository.initialize();

    const first = await (repository as any).listPage({ before: null, limit: 25 });
    const second = await (repository as any).listPage({ before: first.nextCursor, limit: 25 });
    const third = await (repository as any).listPage({ before: second.nextCursor, limit: 25 });
    const ids = [...first.items, ...second.items, ...third.items].map(item => item.id);

    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(25);
    expect(third.items).toHaveLength(3);
    expect(third.nextCursor).toBeNull();
    expect(new Set(ids).size).toBe(53);
    expect(database.calls.some(call =>
      call.sql.includes('(created_at < ? OR (created_at = ? AND id < ?))') &&
      call.params.length === 4,
    )).toBe(true);
  });

  it('rejects the 10001st report inside the same exclusive count-and-insert transaction', async () => {
    const database = new FakeReportDatabase();
    const { repository } = harness({ database });
    await repository.initialize();
    database.reportCountOverride = 10_000;
    const callsBeforeSave = database.calls.length;

    await expect(repository.save({ result: result() })).rejects.toBeInstanceOf(LocalStorageError);

    const saveCalls = database.calls.slice(callsBeforeSave).map(call => call.sql);
    expect(saveCalls[0]).toBe('BEGIN EXCLUSIVE');
    expect(saveCalls).toContain('SELECT COUNT(*) AS count FROM reports');
    expect(saveCalls.some(sql => /^INSERT INTO reports/.test(sql))).toBe(false);
    expect(saveCalls.at(-1)).toBe('ROLLBACK');
    expect(database.rows).toEqual([]);
  });

  it('saves a strict report projection with a local-date default title', async () => {
    const { repository } = harness({ now: () => new Date(2026, 7, 5, 12, 34, 56, 789) });
    await repository.initialize();

    const saved = await repository.save({ result: result() });

    expect(saved).toEqual<ReportRecord>({
      id: FIRST_ID,
      title: 'Resume analysis — 2026-08-05',
      createdAt: new Date(2026, 7, 5, 12, 34, 56, 789).toISOString(),
      sourceType: 'text',
      score: result().score,
      aiStatus: 'legacy_feedback_present',
      feedback: result().feedback,
    });
  });

  it('stores generated feedback exactly even when it restates synthetic private input', async () => {
    const syntheticEmail = 'candidate@example.invalid';
    const syntheticPrivateLine = 'Private project line from the resume';
    const analysis = result();
    analysis.feedback.summary = `Contact ${syntheticEmail}`;
    analysis.feedback.powerBullets = [syntheticPrivateLine];
    const { database, repository } = harness();
    await repository.initialize();

    const saved = await repository.save({
      result: analysis,
      filename: 'Private Name.pdf',
      resumeText: syntheticPrivateLine,
      jobDescription: 'Private target role',
      installationToken: 'private-installation-token',
      requestId: 'private-request-id',
    });

    expect(saved.feedback).toEqual(analysis.feedback);
    expect(JSON.parse(database.rows[0]?.feedback_json as string)).toEqual(
      analysis.feedback,
    );
    expect(JSON.stringify(database.rows[0])).not.toContain('Private Name.pdf');
    expect(JSON.stringify(database.rows[0])).not.toContain('Private target role');
    expect(JSON.stringify(database.rows[0])).not.toContain('private-installation-token');
    expect(JSON.stringify(database.rows[0])).not.toContain('private-request-id');
  });

  it('supports a bounded explicit title and deterministic newest-first ordering', async () => {
    let current = new Date('2026-08-05T10:00:00.000Z');
    const { repository } = harness({ now: () => current });
    await repository.initialize();
    await repository.save({ result: result(FIRST_ID), title: 'First report' });
    current = new Date('2026-08-06T10:00:00.000Z');
    await repository.save({ result: result(SECOND_ID), title: 'Second report' });

    expect((await repository.list()).map(record => record.id)).toEqual([SECOND_ID, FIRST_ID]);
    expect(await repository.get(FIRST_ID)).toMatchObject({ id: FIRST_ID, title: 'First report' });
  });

  it('breaks equal-timestamp ordering ties by descending report ID', async () => {
    const { repository } = harness();
    await repository.initialize();
    await repository.save({ result: result(FIRST_ID) });
    await repository.save({ result: result(SECOND_ID) });

    expect((await repository.list()).map(record => record.id)).toEqual([SECOND_ID, FIRST_ID]);
  });

  it('rejects duplicate report IDs instead of overwriting an earlier record', async () => {
    const { repository } = harness();
    await repository.initialize();
    await repository.save({ result: result(), title: 'Original' });

    await expect(repository.save({ result: result(), title: 'Replacement' })).rejects.toMatchObject({ category: 'local_storage' });
    expect(await repository.get(FIRST_ID)).toMatchObject({ title: 'Original' });
  });

  it('snapshots the allowlisted projection before waiting behind an earlier operation', async () => {
    const blocker = deferred<void>();
    const { database, repository } = harness();
    await repository.initialize();
    database.beforeList = () => blocker.promise;
    const predecessor = repository.list();
    const input = {
      result: result(),
      filename: 'Private Name.pdf',
      resumeText: 'private original draft',
    };

    const saving = repository.save(input);
    input.result.feedback.summary = 'Mutated after save was called.';
    input.filename = 'Mutated Private Name.pdf';
    input.resumeText = 'mutated private draft';
    blocker.resolve();
    await predecessor;

    await expect(saving).resolves.toMatchObject({
      feedback: { summary: validFixture.feedback.summary },
    });
    expect(database.rows[0]?.feedback_json).toBe(JSON.stringify(validFixture.feedback));
    expect(JSON.stringify(database.calls)).not.toContain('Mutated Private Name.pdf');
    expect(JSON.stringify(database.calls)).not.toContain('mutated private draft');
  });

  it.each([
    ['future row version', { schema_version: 3 }],
    ['invalid UUID', { id: 'PRIVATE-ID' }],
    ['invalid date', { created_at: 'August 5' }],
    ['invalid source', { source_type: 'camera' }],
    ['blank title', { title: '   ' }],
    ['extra column', { resume_text: 'private resume' }],
    ['missing column', { feedback_json: undefined }],
    ['invalid score JSON', { score_json: '{private' }],
    ['invalid score shape', { score_json: JSON.stringify({ ...validFixture.score, label: 'Needs work' }) }],
    ['score above job branch maximum', { score_json: JSON.stringify({
      ...validFixture.score,
      readinessScore: 86,
      components: { ...validFixture.score.components, structure: 26 },
    }) }],
    ['invalid feedback shape', { feedback_json: '{}' }],
    ['oversized score JSON', { score_json: 'x'.repeat(16_385) }],
    ['oversized feedback JSON', { feedback_json: 'x'.repeat(131_073) }],
  ])('rejects %s with a stable content-free read error', async (_name, change) => {
    const database = FakeReportDatabase.versionOne();
    database.rows.push({
      id: FIRST_ID,
      schema_version: 1,
      title: 'Resume analysis — 2026-08-05',
      created_at: '2026-08-05T19:20:30.000Z',
      source_type: 'text',
      score_json: JSON.stringify(validFixture.score),
      feedback_json: JSON.stringify(validFixture.feedback),
      ...change,
    });
    if ('feedback_json' in change && change.feedback_json === undefined) {
      delete database.rows[0].feedback_json;
    }
    const { repository } = harness({ database });
    await repository.initialize();

    const error = await repository.list().catch(reason => reason as unknown);
    expectLocalStorageError(error);
    expect(JSON.stringify(error)).not.toContain('private');
  });

  it.each([
    ['invalid analysis response', { result: { ...validFixture, sourceType: 'camera' } }],
    ['invalid title whitespace', { result: validFixture, title: ' padded ' }],
    ['invalid title control character', { result: validFixture, title: 'private\ttitle' }],
    ['oversized title', { result: validFixture, title: '💼'.repeat(81) }],
  ])('rejects %s before issuing an insert', async (_name, input) => {
    const { database, repository } = harness();
    await repository.initialize();

    await expect(repository.save(input)).rejects.toMatchObject({ category: 'local_storage' });
    expect(database.calls.some(call => /^INSERT INTO reports/.test(call.sql))).toBe(false);
  });
});

describe('serialized deletion and lifecycle', () => {
  it('uses parameterized IDs and returns exact missing/existing delete counts', async () => {
    const { database, repository } = harness();
    await repository.initialize();
    await repository.save({ result: result() });

    await expect(repository.delete(SECOND_ID)).resolves.toBe(0);
    await expect(repository.delete(FIRST_ID)).resolves.toBe(1);

    const deletes = database.calls.filter(call => call.sql === 'DELETE FROM reports WHERE id = ?');
    expect(deletes.map(call => call.params)).toEqual([[SECOND_ID], [FIRST_ID]]);
  });

  it.each([
    ['cleanup rejection', async () => { throw new Error('private disk path'); }],
    ['failed cleanup', async () => ({ ...DETAILED_CLEAN, attempted: 1, failed: 1 })],
    ['refused cleanup', async () => ({ ...DETAILED_CLEAN, refused: 1 })],
    ['live cleanup', async () => ({ ...DETAILED_CLEAN, live: 1 })],
    ['untruthful cleanup', async () => ({ ...DETAILED_CLEAN, attempted: 2, deleted: 1 })],
    ['malformed cleanup', async () => ({ ...DETAILED_CLEAN, attempted: -1, deleted: -1, path: 'private' })],
  ])('rolls back report deletion for %s', async (_name, cleanup) => {
    const { repository } = harness({ cleanup });
    await repository.initialize();
    await repository.save({ result: result() });

    await expect(repository.deleteAll()).rejects.toMatchObject({ category: 'local_storage' });
    expect(await repository.list()).toHaveLength(1);
  });

  it('rolls back report deletion when required temp cleanup times out', async () => {
    const { repository } = harness({ cleanup: () => new Promise(() => undefined), cleanupTimeoutMs: 5 });
    await repository.initialize();
    await repository.save({ result: result() });

    await expect(repository.deleteAll()).rejects.toMatchObject({ category: 'local_storage' });
    expect(await repository.list()).toHaveLength(1);
  });

  it('returns only truthful committed report and temp-file counts', async () => {
    const cleanup: AbandonedCleanupReceipt = {
      attempted: 2,
      deleted: 2,
      failed: 0,
      refused: 0,
      deletedFiles: 2,
      live: 0,
    };
    const { repository } = harness({ cleanup: async () => cleanup });
    await repository.initialize();
    await repository.save({ result: result(FIRST_ID) });
    await repository.save({ result: result(SECOND_ID) });

    await expect(repository.deleteAll()).resolves.toEqual({
      deletedReports: 2,
      deletedTempFiles: 2,
      failures: 0,
    });
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('reports verified file deletions rather than deleted request directories', async () => {
    const repository = new ReportRepository({
      openDatabase: async () => new FakeReportDatabase(),
      tempFiles: {
        cleanupAbandonedDetailed: async () => ({
          attempted: 1,
          deleted: 1,
          failed: 0,
          refused: 0,
          deletedFiles: 3,
          live: 0,
        }),
      },
    });
    await repository.initialize();
    await repository.save({ result: result() });

    await expect(repository.deleteAll()).resolves.toEqual({
      deletedReports: 1,
      deletedTempFiles: 3,
      failures: 0,
    });
  });

  it('rolls delete-all back while a staged PDF has a live cache lease', async () => {
    const fileSystem = new LiveCacheFileSystem();
    const owner = new TempFileRegistry({ fileSystem });
    const cleaner = new TempFileRegistry({ fileSystem });
    const liveUri = `file:///app/cache/resume-ai-v1/${REQUEST_A}/${FILE_A}.pdf`;
    await owner.stagePdf(REQUEST_A, FILE_A, 'file:///provider/resume.pdf');
    const repository = new ReportRepository({
      openDatabase: async () => new FakeReportDatabase(),
      tempFiles: cleaner,
    });
    await repository.initialize();
    await repository.save({ result: result() });

    await expect(repository.deleteAll()).rejects.toMatchObject({ category: 'local_storage' });
    await expect(repository.list()).resolves.toHaveLength(1);
    expect(fileSystem.files.has(liveUri)).toBe(true);
    expect(fileSystem.deleted).toEqual([]);
  });

  it('does not claim report deletion when the database fails before or after cleanup', async () => {
    const before = FakeReportDatabase.versionOne();
    before.rows.push({ id: FIRST_ID });
    before.failNext = /^SELECT COUNT/;
    const beforeHarness = harness({ database: before });
    await beforeHarness.repository.initialize();
    await expect(beforeHarness.repository.deleteAll()).rejects.toMatchObject({ category: 'local_storage' });
    expect(beforeHarness.cleanupAbandoned).not.toHaveBeenCalled();
    expect(before.rows).toHaveLength(1);

    const afterHarness = harness({ database: FakeReportDatabase.versionOne() });
    await afterHarness.repository.initialize();
    await afterHarness.repository.save({ result: result() });
    afterHarness.database.failCommit = true;
    await expect(afterHarness.repository.deleteAll()).rejects.toMatchObject({ category: 'local_storage' });
    expect(afterHarness.cleanupAbandoned).toHaveBeenCalledTimes(1);
    expect(afterHarness.database.rows).toHaveLength(1);
  });

  it('serializes authorized save, delete, read, delete-all, and close without use-after-close', async () => {
    const insert = deferred<void>();
    const { database, repository } = harness();
    await repository.initialize();
    database.beforeInsert = () => insert.promise;

    const saving = repository.save({ result: result(FIRST_ID) });
    const deleting = repository.delete(FIRST_ID);
    const savingAgain = repository.save({ result: result(SECOND_ID) });
    const listing = repository.list();
    const deletingAll = repository.deleteAll();
    const closing = repository.close();
    await Promise.resolve();

    expect(database.closeCount).toBe(0);
    insert.resolve();
    await saving;
    await expect(deleting).resolves.toBe(1);
    await savingAgain;
    await expect(listing).resolves.toEqual([expect.objectContaining({ id: SECOND_ID })]);
    await expect(deletingAll).resolves.toEqual({ deletedReports: 1, deletedTempFiles: 0, failures: 0 });
    await closing;
    expect(database.closeCount).toBe(1);
    expect(database.rows).toEqual([]);
  });

  it('rejects new work once close is requested and closes once during initialization', async () => {
    const opened = deferred<FakeReportDatabase>();
    const database = FakeReportDatabase.versionOne();
    const repository = new ReportRepository({
      openDatabase: () => opened.promise,
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });
    const initializing = repository.initialize();
    const closing = repository.close();

    await expect(repository.list()).rejects.toMatchObject({ category: 'local_storage' });
    opened.resolve(database);
    await initializing;
    await closing;
    await repository.close();
    expect(database.closeCount).toBe(1);
    await expect(repository.get(FIRST_ID)).rejects.toMatchObject({ category: 'local_storage' });
  });

  it('rejects operations before initialization with no implicit database open', async () => {
    const { openDatabase, repository } = harness();

    await expect(repository.list()).rejects.toMatchObject({ category: 'local_storage' });
    expect(openDatabase).not.toHaveBeenCalled();
  });
});
