import {
  defaultDatabaseDirectory,
  openDatabaseAsync,
  type SQLiteDatabase,
} from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';

import {
  AddSnapshotInputSchema,
  JobRecordSchema,
  ResumeVersionSchema,
  SaveJobInputSchema,
  SaveVersionInputSchema,
  VersionSnapshotSchema,
  WorkspaceIdentifierSchema,
  WorkspacePageRequestSchema,
  WorkspacePlanSnapshotSchema,
  type AddSnapshotInput,
  type JobRecord,
  type ResumeVersion,
  type SaveJobInput,
  type SaveVersionInput,
  type VersionSnapshot,
  type WorkspacePage,
  type WorkspacePageRequest,
  type WorkspacePlanSnapshot,
} from './contracts';
import {
  WORKSPACE_DATABASE_NAME,
  WORKSPACE_SCHEMA_VERSION,
  migrateWorkspaceDatabase,
  type WorkspaceDatabase,
  type WorkspaceSqlExecutor,
  type WorkspaceSqlValue,
} from './migrations';

const SCORE_JSON_LIMIT = 16_384;
const KEYWORDS_JSON_LIMIT = 16_384;
const MAX_SNAPSHOTS_PER_VERSION = 100;

function defaultIdentity(): string {
  if (typeof defaultDatabaseDirectory !== 'string' || defaultDatabaseDirectory.length === 0) {
    return `expo-sqlite:default/${WORKSPACE_DATABASE_NAME}`;
  }
  return `${defaultDatabaseDirectory.replace(/\/*$/, '')}/${WORKSPACE_DATABASE_NAME.replace(/^\/+/, '')}`;
}

export const WORKSPACE_DATABASE_IDENTITY = defaultIdentity();

const VersionRowSchema = z.object({
  id: WorkspaceIdentifierSchema,
  schema_version: z.literal(WORKSPACE_SCHEMA_VERSION),
  title: z.string(),
  role_label: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  latest_snapshot_id: WorkspaceIdentifierSchema,
}).strict();

const SnapshotRowSchema = z.object({
  id: WorkspaceIdentifierSchema,
  schema_version: z.literal(WORKSPACE_SCHEMA_VERSION),
  version_id: WorkspaceIdentifierSchema,
  created_at: z.string(),
  resume_text: z.string(),
  score_json: z.string().max(SCORE_JSON_LIMIT),
  keywords_json: z.string().max(KEYWORDS_JSON_LIMIT),
}).strict();

const JobRowSchema = z.object({
  id: WorkspaceIdentifierSchema,
  schema_version: z.literal(WORKSPACE_SCHEMA_VERSION),
  company_label: z.string(),
  role_label: z.string(),
  status: z.string(),
  next_action_at: z.string().nullable(),
  notes: z.string(),
  linked_version_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

const CountRowSchema = z.object({ count: z.number().int().nonnegative() }).strict();
const RunResultSchema = z.object({
  lastInsertRowId: z.number().int(),
  changes: z.number().int().nonnegative(),
}).strict();

export type VersionAggregate = Readonly<{
  version: ResumeVersion;
  snapshots: readonly VersionSnapshot[];
}>;

export type SaveVersionReceipt = Readonly<{
  version: ResumeVersion;
  snapshot: VersionSnapshot;
}>;

export type WorkspaceDeleteReceipt = Readonly<{
  deletedVersions: number;
  deletedSnapshots: number;
  deletedJobs: number;
  failures: 0;
}>;

export class WorkspaceStorageError extends Error {
  readonly category = 'workspace_storage' as const;

  constructor() {
    super('The local career workspace could not complete the operation.');
    this.name = 'WorkspaceStorageError';
  }
}

function failure(): WorkspaceStorageError {
  return new WorkspaceStorageError();
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw failure();
  }
}

function versionFromRow(value: unknown): ResumeVersion {
  const row = VersionRowSchema.safeParse(value);
  if (!row.success) throw failure();
  const version = ResumeVersionSchema.safeParse({
    id: row.data.id,
    title: row.data.title,
    roleLabel: row.data.role_label,
    createdAt: row.data.created_at,
    updatedAt: row.data.updated_at,
    latestSnapshotId: row.data.latest_snapshot_id,
  });
  if (!version.success) throw failure();
  return version.data;
}

function snapshotFromRow(value: unknown): VersionSnapshot {
  const row = SnapshotRowSchema.safeParse(value);
  if (!row.success) throw failure();
  const snapshot = VersionSnapshotSchema.safeParse({
    id: row.data.id,
    versionId: row.data.version_id,
    createdAt: row.data.created_at,
    resumeText: row.data.resume_text,
    score: parsedJson(row.data.score_json),
    keywords: parsedJson(row.data.keywords_json),
  });
  if (!snapshot.success) throw failure();
  return snapshot.data;
}

function jobFromRow(value: unknown): JobRecord {
  const row = JobRowSchema.safeParse(value);
  if (!row.success) throw failure();
  const job = JobRecordSchema.safeParse({
    id: row.data.id,
    companyLabel: row.data.company_label,
    roleLabel: row.data.role_label,
    status: row.data.status,
    nextActionAt: row.data.next_action_at,
    notes: row.data.notes,
    linkedVersionId: row.data.linked_version_id,
    createdAt: row.data.created_at,
    updatedAt: row.data.updated_at,
  });
  if (!job.success) throw failure();
  return job.data;
}

function assertedDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw failure();
  return value;
}

function assertedId(value: unknown): string {
  const parsed = WorkspaceIdentifierSchema.safeParse(value);
  if (!parsed.success) throw failure();
  return parsed.data;
}

function runChanges(value: unknown, maximum = 1): number {
  const parsed = RunResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.changes > maximum) throw failure();
  return parsed.data.changes;
}

function countFrom(value: unknown, maximum: number): number {
  const parsed = CountRowSchema.safeParse(value);
  if (!parsed.success || parsed.data.count > maximum) throw failure();
  return parsed.data.count;
}

function planCaps(value: unknown, now: Date): Readonly<{ versions: 1 | 200; jobs: 3 | 500 }> {
  const parsed = WorkspacePlanSnapshotSchema.safeParse(value);
  if (!parsed.success) return { versions: 1, jobs: 3 };
  const verified = Date.parse(parsed.data.verifiedUntil) > now.getTime();
  const entitlement = parsed.data.entitlementExpiresAt === null
    ? null
    : Date.parse(parsed.data.entitlementExpiresAt);
  const pro = parsed.data.kind === 'pro' &&
    verified &&
    entitlement !== null &&
    entitlement > now.getTime();
  return pro ? { versions: 200, jobs: 500 } : { versions: 1, jobs: 3 };
}

function serializedSnapshot(input: AddSnapshotInput): Readonly<{
  scoreJson: string;
  keywordsJson: string;
}> {
  const scoreJson = JSON.stringify(input.score);
  const keywordsJson = JSON.stringify(input.keywords);
  if (scoreJson.length > SCORE_JSON_LIMIT || keywordsJson.length > KEYWORDS_JSON_LIMIT) {
    throw failure();
  }
  return { scoreJson, keywordsJson };
}

export type WorkspaceRepositoryOptions = Readonly<{
  databaseIdentity?: string;
  openDatabase?: () => Promise<WorkspaceDatabase>;
  now?: () => Date;
  idFactory?: () => string;
}>;

export interface WorkspaceRepositoryPort {
  readonly databaseIdentity: string;
  initialize(): Promise<void>;
  saveVersion(input: SaveVersionInput, plan: WorkspacePlanSnapshot): Promise<SaveVersionReceipt>;
  addSnapshot(versionId: string, input: AddSnapshotInput): Promise<VersionSnapshot>;
  listVersions(request: WorkspacePageRequest): Promise<WorkspacePage<ResumeVersion>>;
  getVersion(id: string): Promise<VersionAggregate | null>;
  deleteVersion(id: string): Promise<boolean>;
  saveJob(input: SaveJobInput, plan: WorkspacePlanSnapshot): Promise<JobRecord>;
  listJobs(request: WorkspacePageRequest): Promise<WorkspacePage<JobRecord>>;
  getJob(id: string): Promise<JobRecord | null>;
  deleteJob(id: string): Promise<boolean>;
  deleteAll(): Promise<WorkspaceDeleteReceipt>;
  close(): Promise<void>;
}

export class WorkspaceRepository implements WorkspaceRepositoryPort {
  readonly databaseIdentity: string;
  private readonly openDatabase: () => Promise<WorkspaceDatabase>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private database: WorkspaceDatabase | null = null;
  private initialized = false;
  private closeRequested = false;
  private closePromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceRepositoryOptions = {}) {
    this.databaseIdentity = options.databaseIdentity ?? WORKSPACE_DATABASE_IDENTITY;
    this.openDatabase = options.openDatabase ?? openDefaultDatabase;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => Crypto.randomUUID());
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return;
      if (this.database === null) this.database = await this.openDatabase();
      if (this.database.identity !== this.databaseIdentity) throw failure();
      await migrateWorkspaceDatabase(this.database);
      this.initialized = true;
    });
  }

  saveVersion(input: SaveVersionInput, plan: WorkspacePlanSnapshot): Promise<SaveVersionReceipt> {
    if (this.closeRequested) return Promise.reject(failure());
    try {
      const parsed = SaveVersionInputSchema.parse(input);
      const createdAt = assertedDate(this.now()).toISOString();
      const versionId = assertedId(this.idFactory());
      const snapshotId = assertedId(this.idFactory());
      if (versionId === snapshotId) throw failure();
      const caps = planCaps(plan, new Date(createdAt));
      const serialized = serializedSnapshot(parsed);
      const version = ResumeVersionSchema.parse({
        id: versionId,
        title: parsed.title,
        roleLabel: parsed.roleLabel,
        createdAt,
        updatedAt: createdAt,
        latestSnapshotId: snapshotId,
      });
      const snapshot = VersionSnapshotSchema.parse({
        id: snapshotId,
        versionId,
        createdAt,
        resumeText: parsed.resumeText,
        score: parsed.score,
        keywords: parsed.keywords,
      });
      return this.enqueue(async () => {
        const database = this.readyDatabase();
        await database.withExclusiveTransactionAsync(async transaction => {
          const count = countFrom(
            await transaction.getFirstAsync<unknown>(
              'SELECT COUNT(*) AS count FROM resume_versions',
            ),
            200,
          );
          if (count >= caps.versions) throw failure();
          const versionWrite = await transaction.runAsync(
            `INSERT INTO resume_versions
              (id, schema_version, title, role_label, created_at, updated_at, latest_snapshot_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            version.id,
            WORKSPACE_SCHEMA_VERSION,
            version.title,
            version.roleLabel,
            version.createdAt,
            version.updatedAt,
            version.latestSnapshotId,
          );
          if (runChanges(versionWrite) !== 1) throw failure();
          const snapshotWrite = await transaction.runAsync(
            `INSERT INTO version_snapshots
              (id, schema_version, version_id, created_at, resume_text, score_json, keywords_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            snapshot.id,
            WORKSPACE_SCHEMA_VERSION,
            snapshot.versionId,
            snapshot.createdAt,
            snapshot.resumeText,
            serialized.scoreJson,
            serialized.keywordsJson,
          );
          if (runChanges(snapshotWrite) !== 1) throw failure();
        });
        return { version, snapshot };
      });
    } catch {
      return Promise.reject(failure());
    }
  }

  addSnapshot(versionId: string, input: AddSnapshotInput): Promise<VersionSnapshot> {
    if (this.closeRequested) return Promise.reject(failure());
    try {
      const id = assertedId(versionId);
      const parsed = AddSnapshotInputSchema.parse(input);
      const createdAt = assertedDate(this.now()).toISOString();
      const snapshotId = assertedId(this.idFactory());
      const serialized = serializedSnapshot(parsed);
      const snapshot = VersionSnapshotSchema.parse({
        id: snapshotId,
        versionId: id,
        createdAt,
        resumeText: parsed.resumeText,
        score: parsed.score,
        keywords: parsed.keywords,
      });
      return this.enqueue(async () => {
        const database = this.readyDatabase();
        await database.withExclusiveTransactionAsync(async transaction => {
          const version = await transaction.getFirstAsync<unknown>(
            'SELECT id FROM resume_versions WHERE id = ?',
            id,
          );
          if (version === null) throw failure();
          const count = countFrom(
            await transaction.getFirstAsync<unknown>(
              'SELECT COUNT(*) AS count FROM version_snapshots WHERE version_id = ?',
              id,
            ),
            MAX_SNAPSHOTS_PER_VERSION,
          );
          if (count >= MAX_SNAPSHOTS_PER_VERSION) throw failure();
          if (runChanges(await transaction.runAsync(
            `INSERT INTO version_snapshots
              (id, schema_version, version_id, created_at, resume_text, score_json, keywords_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            snapshot.id,
            WORKSPACE_SCHEMA_VERSION,
            snapshot.versionId,
            snapshot.createdAt,
            snapshot.resumeText,
            serialized.scoreJson,
            serialized.keywordsJson,
          )) !== 1) throw failure();
          if (runChanges(await transaction.runAsync(
            'UPDATE resume_versions SET latest_snapshot_id = ?, updated_at = ? WHERE id = ?',
            snapshot.id,
            snapshot.createdAt,
            id,
          )) !== 1) throw failure();
        });
        return snapshot;
      });
    } catch {
      return Promise.reject(failure());
    }
  }

  listVersions(request: WorkspacePageRequest): Promise<WorkspacePage<ResumeVersion>> {
    const parsed = WorkspacePageRequestSchema.safeParse(request);
    if (!parsed.success) return Promise.reject(failure());
    return this.enqueue(async () => {
      const projection =
        'SELECT id, schema_version, title, role_label, created_at, updated_at, latest_snapshot_id';
      const limit = parsed.data.limit + 1;
      const rows = parsed.data.before === null
        ? await this.readyDatabase().getAllAsync<unknown>(
          `${projection} FROM resume_versions ORDER BY updated_at DESC, id DESC LIMIT ?`,
          limit,
        )
        : await this.readyDatabase().getAllAsync<unknown>(
          `${projection} FROM resume_versions
           WHERE (updated_at < ? OR (updated_at = ? AND id < ?))
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
          parsed.data.before.updatedAt,
          parsed.data.before.updatedAt,
          parsed.data.before.id,
          limit,
        );
      const values = rows.map(versionFromRow);
      const items = values.slice(0, parsed.data.limit);
      const final = items.at(-1);
      return {
        items,
        nextCursor: values.length > parsed.data.limit && final !== undefined
          ? { schemaVersion: 1, updatedAt: final.updatedAt, id: final.id }
          : null,
      };
    });
  }

  getVersion(idValue: string): Promise<VersionAggregate | null> {
    return this.enqueue(async () => {
      const id = assertedId(idValue);
      const row = await this.readyDatabase().getFirstAsync<unknown>(
        `SELECT id, schema_version, title, role_label, created_at, updated_at, latest_snapshot_id
         FROM resume_versions WHERE id = ?`,
        id,
      );
      if (row === null) return null;
      const snapshots = await this.readyDatabase().getAllAsync<unknown>(
        `SELECT id, schema_version, version_id, created_at, resume_text, score_json, keywords_json
         FROM version_snapshots WHERE version_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        id,
        MAX_SNAPSHOTS_PER_VERSION + 1,
      );
      if (snapshots.length > MAX_SNAPSHOTS_PER_VERSION) throw failure();
      const aggregate = { version: versionFromRow(row), snapshots: snapshots.map(snapshotFromRow) };
      if (!aggregate.snapshots.some(item => item.id === aggregate.version.latestSnapshotId)) {
        throw failure();
      }
      return aggregate;
    });
  }

  deleteVersion(idValue: string): Promise<boolean> {
    return this.enqueue(async () => {
      const id = assertedId(idValue);
      const database = this.readyDatabase();
      let deleted = 0;
      await database.withExclusiveTransactionAsync(async transaction => {
        const snapshotCount = countFrom(await transaction.getFirstAsync<unknown>(
          'SELECT COUNT(*) AS count FROM version_snapshots WHERE version_id = ?',
          id,
        ), MAX_SNAPSHOTS_PER_VERSION);
        await transaction.runAsync(
          'UPDATE jobs SET linked_version_id = NULL WHERE linked_version_id = ?',
          id,
        );
        const snapshotDelete = runChanges(await transaction.runAsync(
          'DELETE FROM version_snapshots WHERE version_id = ?',
          id,
        ), snapshotCount);
        if (snapshotDelete !== snapshotCount) throw failure();
        deleted = runChanges(await transaction.runAsync(
          'DELETE FROM resume_versions WHERE id = ?',
          id,
        ));
      });
      return deleted === 1;
    });
  }

  saveJob(input: SaveJobInput, plan: WorkspacePlanSnapshot): Promise<JobRecord> {
    if (this.closeRequested) return Promise.reject(failure());
    try {
      const parsed = SaveJobInputSchema.parse(input);
      const updatedAt = assertedDate(this.now()).toISOString();
      const id = parsed.id ?? assertedId(this.idFactory());
      const caps = planCaps(plan, new Date(updatedAt));
      return this.enqueue(async () => {
        const database = this.readyDatabase();
        let record: JobRecord | null = null;
        await database.withExclusiveTransactionAsync(async transaction => {
          if (parsed.linkedVersionId !== null && await transaction.getFirstAsync<unknown>(
            'SELECT id FROM resume_versions WHERE id = ?',
            parsed.linkedVersionId,
          ) === null) throw failure();
          const existingRow = await transaction.getFirstAsync<unknown>(
            `SELECT id, schema_version, company_label, role_label, status, next_action_at, notes,
                    linked_version_id, created_at, updated_at FROM jobs WHERE id = ?`,
            id,
          );
          const existing = existingRow === null ? null : jobFromRow(existingRow);
          record = JobRecordSchema.parse({
            id,
            companyLabel: parsed.companyLabel,
            roleLabel: parsed.roleLabel,
            status: parsed.status,
            nextActionAt: parsed.nextActionAt,
            notes: parsed.notes,
            linkedVersionId: parsed.linkedVersionId,
            createdAt: existing?.createdAt ?? updatedAt,
            updatedAt,
          });
          if (existing === null) {
            const count = countFrom(await transaction.getFirstAsync<unknown>(
              'SELECT COUNT(*) AS count FROM jobs',
            ), 500);
            if (count >= caps.jobs) throw failure();
            if (runChanges(await transaction.runAsync(
              `INSERT INTO jobs
                (id, schema_version, company_label, role_label, status, next_action_at, notes,
                 linked_version_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              record.id,
              WORKSPACE_SCHEMA_VERSION,
              record.companyLabel,
              record.roleLabel,
              record.status,
              record.nextActionAt,
              record.notes,
              record.linkedVersionId,
              record.createdAt,
              record.updatedAt,
            )) !== 1) throw failure();
          } else if (runChanges(await transaction.runAsync(
            `UPDATE jobs SET company_label = ?, role_label = ?, status = ?, next_action_at = ?,
                    notes = ?, linked_version_id = ?, updated_at = ? WHERE id = ?`,
            record.companyLabel,
            record.roleLabel,
            record.status,
            record.nextActionAt,
            record.notes,
            record.linkedVersionId,
            record.updatedAt,
            record.id,
          )) !== 1) throw failure();
        });
        if (record === null) throw failure();
        return record;
      });
    } catch {
      return Promise.reject(failure());
    }
  }

  listJobs(request: WorkspacePageRequest): Promise<WorkspacePage<JobRecord>> {
    const parsed = WorkspacePageRequestSchema.safeParse(request);
    if (!parsed.success) return Promise.reject(failure());
    return this.enqueue(async () => {
      const projection = `SELECT id, schema_version, company_label, role_label, status,
        next_action_at, notes, linked_version_id, created_at, updated_at`;
      const limit = parsed.data.limit + 1;
      const rows = parsed.data.before === null
        ? await this.readyDatabase().getAllAsync<unknown>(
          `${projection} FROM jobs ORDER BY updated_at DESC, id DESC LIMIT ?`,
          limit,
        )
        : await this.readyDatabase().getAllAsync<unknown>(
          `${projection} FROM jobs
           WHERE (updated_at < ? OR (updated_at = ? AND id < ?))
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
          parsed.data.before.updatedAt,
          parsed.data.before.updatedAt,
          parsed.data.before.id,
          limit,
        );
      const values = rows.map(jobFromRow);
      const items = values.slice(0, parsed.data.limit);
      const final = items.at(-1);
      return {
        items,
        nextCursor: values.length > parsed.data.limit && final !== undefined
          ? { schemaVersion: 1, updatedAt: final.updatedAt, id: final.id }
          : null,
      };
    });
  }

  getJob(idValue: string): Promise<JobRecord | null> {
    return this.enqueue(async () => {
      const id = assertedId(idValue);
      const row = await this.readyDatabase().getFirstAsync<unknown>(
        `SELECT id, schema_version, company_label, role_label, status, next_action_at, notes,
                linked_version_id, created_at, updated_at FROM jobs WHERE id = ?`,
        id,
      );
      return row === null ? null : jobFromRow(row);
    });
  }

  deleteJob(idValue: string): Promise<boolean> {
    return this.enqueue(async () => {
      const id = assertedId(idValue);
      return runChanges(await this.readyDatabase().runAsync(
        'DELETE FROM jobs WHERE id = ?',
        id,
      )) === 1;
    });
  }

  deleteAll(): Promise<WorkspaceDeleteReceipt> {
    return this.enqueue(async () => {
      const database = this.readyDatabase();
      let receipt: WorkspaceDeleteReceipt | null = null;
      await database.withExclusiveTransactionAsync(async transaction => {
        const versions = countFrom(await transaction.getFirstAsync<unknown>(
          'SELECT COUNT(*) AS count FROM resume_versions',
        ), 200);
        const snapshots = countFrom(await transaction.getFirstAsync<unknown>(
          'SELECT COUNT(*) AS count FROM version_snapshots',
        ), 20_000);
        const jobs = countFrom(await transaction.getFirstAsync<unknown>(
          'SELECT COUNT(*) AS count FROM jobs',
        ), 500);
        if (runChanges(await transaction.runAsync('DELETE FROM jobs'), jobs) !== jobs) throw failure();
        if (runChanges(await transaction.runAsync('DELETE FROM version_snapshots'), snapshots) !== snapshots) throw failure();
        if (runChanges(await transaction.runAsync('DELETE FROM resume_versions'), versions) !== versions) throw failure();
        receipt = {
          deletedVersions: versions,
          deletedSnapshots: snapshots,
          deletedJobs: jobs,
          failures: 0,
        };
      });
      if (receipt === null) throw failure();
      return receipt;
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

  private readyDatabase(): WorkspaceDatabase {
    if (!this.initialized || this.database === null) throw failure();
    return this.database;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closeRequested) return Promise.reject(failure());
    return this.enqueueAuthorized(operation);
  }

  private enqueueAuthorized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      try {
        return await operation();
      } catch {
        throw failure();
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

class ExpoWorkspaceAdapter implements WorkspaceDatabase {
  readonly identity: string;

  constructor(private readonly database: SQLiteDatabase) {
    this.identity = database.databasePath;
  }

  execAsync(source: string): Promise<void> { return this.database.execAsync(source); }
  runAsync(source: string, ...params: WorkspaceSqlValue[]) {
    return this.database.runAsync(source, ...params);
  }
  getFirstAsync<T>(source: string, ...params: WorkspaceSqlValue[]): Promise<T | null> {
    return this.database.getFirstAsync<T>(source, ...params);
  }
  getAllAsync<T>(source: string, ...params: WorkspaceSqlValue[]): Promise<T[]> {
    return this.database.getAllAsync<T>(source, ...params);
  }
  withExclusiveTransactionAsync(
    task: (transaction: WorkspaceSqlExecutor) => Promise<void>,
  ): Promise<void> {
    return this.database.withExclusiveTransactionAsync(transaction => task(transaction));
  }
  closeAsync(): Promise<void> { return this.database.closeAsync(); }
}

async function openDefaultDatabase(): Promise<WorkspaceDatabase> {
  const database = new ExpoWorkspaceAdapter(await openDatabaseAsync(WORKSPACE_DATABASE_NAME));
  if (database.identity !== WORKSPACE_DATABASE_IDENTITY) {
    await database.closeAsync();
    throw failure();
  }
  return database;
}
