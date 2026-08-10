import {
  defaultDatabaseDirectory,
  openDatabaseAsync,
  type SQLiteDatabase,
} from 'expo-sqlite';
import { z } from 'zod';

import {
  AnalysisResultSchema,
  FeedbackSchema,
  ScoreSchema,
} from '../domain/contracts';
import { codePointLength } from '../domain/limits';
import {
  TempFileRegistry,
  type AbandonedCleanupReceipt,
} from '../documents/tempFileRegistry';
import {
  REPORT_DATABASE_NAME,
  REPORT_SCHEMA_VERSION,
  migrateReportDatabase,
  type ReportDatabase,
  type ReportSqlValue,
} from './migrations';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCORE_JSON_LIMIT = 16_384;
const FEEDBACK_JSON_LIMIT = 131_072;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const MAX_REPORTS = 10_000;

function defaultReportDatabaseIdentity(): string {
  if (typeof defaultDatabaseDirectory !== 'string' || defaultDatabaseDirectory.length === 0) {
    return `expo-sqlite:default/${REPORT_DATABASE_NAME}`;
  }
  return `${defaultDatabaseDirectory.replace(/\/*$/, '')}/${REPORT_DATABASE_NAME.replace(/^\/+/, '')}`;
}

export const REPORT_DATABASE_IDENTITY = defaultReportDatabaseIdentity();

const IdentifierSchema = z.string().regex(UUID_PATTERN);
const SourceTypeSchema = z.enum(['pdf', 'text', 'vision_text', 'reviewed_text']);
const PersistedAiStatusSchema = z.enum([
  'complete',
  'not_requested',
  'quota_exhausted',
  'plan_verification_unavailable',
  'temporarily_unavailable',
  'timeout',
  'invalid_provider_response',
  'legacy_feedback_present',
]);
export type ReportAiStatus = z.infer<typeof PersistedAiStatusSchema>;

const TitleSchema = z.string().superRefine((value, context) => {
  const length = codePointLength(value);
  if (
    length < 1 ||
    length > 80 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    context.addIssue({ code: 'custom', message: 'Invalid local report title.' });
  }
});

const CanonicalTimestampSchema = z.string().superRefine((value, context) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    context.addIssue({ code: 'custom', message: 'Invalid local report timestamp.' });
  }
});

export const ReportRecordSchema = z
  .object({
    id: IdentifierSchema,
    title: TitleSchema,
    createdAt: CanonicalTimestampSchema,
    sourceType: SourceTypeSchema,
    score: ScoreSchema,
    aiStatus: PersistedAiStatusSchema,
    feedback: FeedbackSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const feedbackRequired =
      record.aiStatus === 'complete' || record.aiStatus === 'legacy_feedback_present';
    if (feedbackRequired !== (record.feedback !== null)) {
      context.addIssue({ code: 'custom', message: 'Stored AI status and feedback disagree.' });
    }
  });

const ReportRowSchema = z
  .object({
    id: IdentifierSchema,
    schema_version: z.literal(REPORT_SCHEMA_VERSION),
    title: TitleSchema,
    created_at: CanonicalTimestampSchema,
    source_type: SourceTypeSchema,
    score_json: z.string().max(SCORE_JSON_LIMIT),
    feedback_json: z.string().max(FEEDBACK_JSON_LIMIT),
    ai_status: PersistedAiStatusSchema,
  })
  .strict();

const CountRowSchema = z.object({ count: z.number().int().nonnegative() }).strict();
const RunResultSchema = z
  .object({ lastInsertRowId: z.number().int(), changes: z.number().int().nonnegative() })
  .strict();
const AbandonedCleanupReceiptSchema = z
  .object({
    attempted: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    deletedFiles: z.number().int().nonnegative(),
    live: z.number().int().nonnegative(),
  })
  .strict();

export type ReportRecord = Readonly<z.infer<typeof ReportRecordSchema>>;

export type SaveReportInput = Readonly<{
  result: unknown;
  title?: unknown;
  [runtimeField: string]: unknown;
}>;

export type DeleteReceipt = Readonly<{
  deletedReports: number;
  deletedTempFiles: number;
  failures: number;
}>;

export interface AbandonedCacheCleanup {
  cleanupAbandonedDetailed(): Promise<AbandonedCleanupReceipt>;
}

type PreparedReportWrite = Readonly<{
  record: ReportRecord;
  scoreJson: string;
  feedbackJson: string;
  maximumReports: 3 | 10_000;
}>;

export class LocalStorageError extends Error {
  readonly category = 'local_storage' as const;
  readonly code = 'operation_failed' as const;

  constructor() {
    super('Local report storage could not complete the operation.');
    this.name = 'LocalStorageError';
  }
}

function storageError(): LocalStorageError {
  return new LocalStorageError();
}

function assertDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw storageError();
  return value;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function defaultTitle(date: Date): string {
  return `Resume analysis — ${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw storageError();
  }
}

function recordFromRow(value: unknown): ReportRecord {
  const row = ReportRowSchema.safeParse(value);
  if (!row.success) throw storageError();

  const record = ReportRecordSchema.safeParse({
    id: row.data.id,
    title: row.data.title,
    createdAt: row.data.created_at,
    sourceType: row.data.source_type,
    score: parseJson(row.data.score_json),
    feedback: parseJson(row.data.feedback_json),
    aiStatus: row.data.ai_status,
  });
  if (!record.success) throw storageError();
  return record.data;
}

function projectionFromInput(input: unknown, now: Date): ReportRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw storageError();
  const fields = input as Record<string, unknown>;
  const result = AnalysisResultSchema.safeParse(fields.result);
  if (!result.success) throw storageError();
  const title = fields.title === undefined ? defaultTitle(now) : fields.title;
  const aiStatus = result.data.schemaVersion === 1
    ? 'legacy_feedback_present'
    : result.data.aiStatus;
  const record = ReportRecordSchema.safeParse({
    id: result.data.analysisId,
    title,
    createdAt: now.toISOString(),
    sourceType: result.data.sourceType,
    score: result.data.score,
    feedback: result.data.feedback,
    aiStatus,
  });
  if (!record.success) throw storageError();
  return record.data;
}

function serializeRecord(record: ReportRecord): {
  scoreJson: string;
  feedbackJson: string;
} {
  const scoreJson = JSON.stringify(record.score);
  const feedbackJson = JSON.stringify(record.feedback);
  if (scoreJson.length > SCORE_JSON_LIMIT || feedbackJson.length > FEEDBACK_JSON_LIMIT) {
    throw storageError();
  }
  return { scoreJson, feedbackJson };
}

function assertRunResult(value: unknown, maximumChanges = 1): number {
  const parsed = RunResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.changes > maximumChanges) throw storageError();
  return parsed.data.changes;
}

function verifiedCleanupReceipt(value: unknown): AbandonedCleanupReceipt {
  const parsed = AbandonedCleanupReceiptSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.failed !== 0 ||
    parsed.data.refused !== 0 ||
    parsed.data.live !== 0 ||
    parsed.data.attempted !== parsed.data.deleted
  ) {
    throw storageError();
  }
  return parsed.data;
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(storageError());
    }, timeoutMs);

    Promise.resolve()
      .then(operation)
      .then(
        value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(storageError());
        },
      );
  });
}

export type ReportRepositoryOptions = Readonly<{
  databaseIdentity?: string;
  openDatabase?: () => Promise<ReportDatabase>;
  tempFiles?: AbandonedCacheCleanup;
  now?: () => Date;
  cleanupTimeoutMs?: number;
}>;

const ReportCursorSchema = z
  .object({
    schemaVersion: z.literal(1),
    createdAt: CanonicalTimestampSchema,
    id: IdentifierSchema,
  })
  .strict();

const ReportPageRequestSchema = z
  .object({
    before: ReportCursorSchema.nullable(),
    limit: z.number().int().min(1).max(50),
  })
  .strict();

const SaveReportPolicySchema = z
  .object({ maximumReports: z.union([z.literal(3), z.literal(10_000)]) })
  .strict();

export type SaveReportPolicy = Readonly<z.infer<typeof SaveReportPolicySchema>>;

export type ReportCursor = Readonly<z.infer<typeof ReportCursorSchema>>;
export type ReportPageRequest = Readonly<z.infer<typeof ReportPageRequestSchema>>;
export type ReportPage = Readonly<{
  items: readonly ReportRecord[];
  nextCursor: ReportCursor | null;
}>;

export interface ReportRepositoryPort {
  readonly databaseIdentity: string;
  initialize(): Promise<void>;
  save(input: SaveReportInput, policy?: SaveReportPolicy): Promise<ReportRecord>;
  count(): Promise<number>;
  listPage(request: ReportPageRequest): Promise<ReportPage>;
  /** Bounded compatibility read. New callers must use listPage. */
  list(): Promise<ReportRecord[]>;
  get(id: string): Promise<ReportRecord | null>;
  delete(id: string): Promise<number>;
  deleteAll(): Promise<DeleteReceipt>;
  close(): Promise<void>;
}

export class ReportRepository implements ReportRepositoryPort {
  readonly databaseIdentity: string;
  private readonly openDatabase: () => Promise<ReportDatabase>;
  private readonly tempFiles: AbandonedCacheCleanup;
  private readonly now: () => Date;
  private readonly cleanupTimeoutMs: number;
  private queue: Promise<void> = Promise.resolve();
  private database: ReportDatabase | null = null;
  private initialized = false;
  private closeRequested = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: ReportRepositoryOptions = {}) {
    this.databaseIdentity = options.databaseIdentity ?? REPORT_DATABASE_IDENTITY;
    this.openDatabase = options.openDatabase ?? openDefaultReportDatabase;
    this.tempFiles = options.tempFiles ?? new TempFileRegistry();
    this.now = options.now ?? (() => new Date());
    const timeout = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw storageError();
    this.cleanupTimeoutMs = timeout;
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return;
      if (this.database === null) this.database = await this.openDatabase();
      if (this.database.identity !== this.databaseIdentity) throw storageError();
      await migrateReportDatabase(this.database);
      this.initialized = true;
    });
  }

  save(
    input: SaveReportInput,
    policy: SaveReportPolicy = { maximumReports: MAX_REPORTS },
  ): Promise<ReportRecord> {
    if (this.closeRequested) return Promise.reject(storageError());
    let prepared: PreparedReportWrite;
    try {
      const record = projectionFromInput(input, assertDate(this.now()));
      const parsedPolicy = SaveReportPolicySchema.parse(policy);
      prepared = {
        record,
        ...serializeRecord(record),
        maximumReports: parsedPolicy.maximumReports,
      };
    } catch {
      return Promise.reject(storageError());
    }
    return this.enqueuePreparedSave(prepared);
  }

  private enqueuePreparedSave(prepared: PreparedReportWrite): Promise<ReportRecord> {
    return this.enqueue(async () => {
      const database = this.readyDatabase();
      const { record, scoreJson, feedbackJson, maximumReports } = prepared;
      await database.withExclusiveTransactionAsync(async transaction => {
        const count = CountRowSchema.safeParse(
          await transaction.getFirstAsync<unknown>('SELECT COUNT(*) AS count FROM reports'),
        );
        if (!count.success || count.data.count >= maximumReports) throw storageError();
        const write = await transaction.runAsync(
          `INSERT INTO reports
            (id, schema_version, title, created_at, source_type, score_json, feedback_json, ai_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          record.id,
          REPORT_SCHEMA_VERSION,
          record.title,
          record.createdAt,
          record.sourceType,
          scoreJson,
          feedbackJson,
          record.aiStatus,
        );
        if (assertRunResult(write) !== 1) throw storageError();
      });
      return record;
    });
  }

  count(): Promise<number> {
    return this.enqueue(async () => {
      const count = CountRowSchema.safeParse(
        await this.readyDatabase().getFirstAsync<unknown>(
          'SELECT COUNT(*) AS count FROM reports',
        ),
      );
      if (!count.success || count.data.count > MAX_REPORTS) throw storageError();
      return count.data.count;
    });
  }

  listPage(request: ReportPageRequest): Promise<ReportPage> {
    const parsed = ReportPageRequestSchema.safeParse(request);
    if (!parsed.success) return Promise.reject(storageError());
    return this.enqueue(async () => {
      const projection =
        'SELECT id, schema_version, title, created_at, source_type, score_json, feedback_json, ai_status';
      const pageSize = parsed.data.limit + 1;
      const rows = parsed.data.before === null
        ? await this.readyDatabase().getAllAsync<unknown>(
          `${projection} FROM reports ORDER BY created_at DESC, id DESC LIMIT ?`,
          pageSize,
        )
        : await this.readyDatabase().getAllAsync<unknown>(
          `${projection} FROM reports
           WHERE (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          parsed.data.before.createdAt,
          parsed.data.before.createdAt,
          parsed.data.before.id,
          pageSize,
        );
      if (!Array.isArray(rows)) throw storageError();
      const parsedRows = rows.map(recordFromRow);
      const items = parsedRows.slice(0, parsed.data.limit);
      const final = items.at(-1);
      return {
        items,
        nextCursor: parsedRows.length > parsed.data.limit && final !== undefined
          ? { schemaVersion: 1, createdAt: final.createdAt, id: final.id }
          : null,
      };
    });
  }

  list(): Promise<ReportRecord[]> {
    return this.listPage({ before: null, limit: 50 }).then(page => [...page.items]);
  }

  get(id: string): Promise<ReportRecord | null> {
    return this.enqueue(async () => {
      const parsedId = IdentifierSchema.safeParse(id);
      if (!parsedId.success) throw storageError();
      const row = await this.readyDatabase().getFirstAsync<unknown>(
        `SELECT id, schema_version, title, created_at, source_type, score_json, feedback_json, ai_status
         FROM reports WHERE id = ?`,
        parsedId.data,
      );
      return row === null ? null : recordFromRow(row);
    });
  }

  delete(id: string): Promise<number> {
    return this.enqueue(async () => {
      const parsedId = IdentifierSchema.safeParse(id);
      if (!parsedId.success) throw storageError();
      const result = await this.readyDatabase().runAsync(
        'DELETE FROM reports WHERE id = ?',
        parsedId.data,
      );
      return assertRunResult(result);
    });
  }

  deleteAll(): Promise<DeleteReceipt> {
    return this.enqueue(async () => {
      const database = this.readyDatabase();
      let deletedReports: number | null = null;
      let cleanup: AbandonedCleanupReceipt | null = null;
      await database.withExclusiveTransactionAsync(async transaction => {
        const count = CountRowSchema.safeParse(
          await transaction.getFirstAsync<unknown>('SELECT COUNT(*) AS count FROM reports'),
        );
        if (!count.success) throw storageError();
        const deletion = await transaction.runAsync('DELETE FROM reports');
        const changes = assertRunResult(deletion, count.data.count);
        if (changes !== count.data.count) throw storageError();

        const receipt = await withTimeout(
          () => this.tempFiles.cleanupAbandonedDetailed(),
          this.cleanupTimeoutMs,
        );
        cleanup = verifiedCleanupReceipt(receipt);
        deletedReports = changes;
      });
      if (deletedReports === null || cleanup === null) throw storageError();
      return {
        deletedReports,
        deletedTempFiles: (cleanup as AbandonedCleanupReceipt).deletedFiles,
        failures: 0,
      };
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = this.enqueueAuthorized(async () => {
      const database = this.database;
      this.database = null;
      this.initialized = false;
      if (database !== null) await database.closeAsync();
    });
    return this.closePromise;
  }

  private readyDatabase(): ReportDatabase {
    if (!this.initialized || this.database === null) throw storageError();
    return this.database;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closeRequested) return Promise.reject(storageError());
    return this.enqueueAuthorized(operation);
  }

  private enqueueAuthorized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      try {
        return await operation();
      } catch {
        throw storageError();
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class ExpoReportDatabaseAdapter implements ReportDatabase {
  readonly identity: string;

  constructor(private readonly database: SQLiteDatabase) {
    this.identity = database.databasePath;
  }

  execAsync(source: string): Promise<void> {
    return this.database.execAsync(source);
  }

  runAsync(source: string, ...params: ReportSqlValue[]) {
    return this.database.runAsync(source, ...params);
  }

  getFirstAsync<T>(source: string, ...params: ReportSqlValue[]): Promise<T | null> {
    return this.database.getFirstAsync<T>(source, ...params);
  }

  getAllAsync<T>(source: string, ...params: ReportSqlValue[]): Promise<T[]> {
    return this.database.getAllAsync<T>(source, ...params);
  }

  withExclusiveTransactionAsync(
    task: Parameters<ReportDatabase['withExclusiveTransactionAsync']>[0],
  ): Promise<void> {
    return this.database.withExclusiveTransactionAsync(transaction => task(transaction));
  }

  closeAsync(): Promise<void> {
    return this.database.closeAsync();
  }
}

async function openDefaultReportDatabase(): Promise<ReportDatabase> {
  const database = new ExpoReportDatabaseAdapter(
    await openDatabaseAsync(REPORT_DATABASE_NAME),
  );
  if (database.identity !== REPORT_DATABASE_IDENTITY) {
    await database.closeAsync();
    throw storageError();
  }
  return database;
}
