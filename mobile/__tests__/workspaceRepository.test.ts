import validFixture from '../../contracts/fixtures/analysis-valid.json';

import {
  WorkspaceRepository,
  WorkspaceStorageError,
} from '../src/workspace/workspaceRepository';
import type {
  AddSnapshotInput,
  SaveVersionInput,
  WorkspacePlanSnapshot,
} from '../src/workspace/contracts';
import { FakeWorkspaceDatabase } from '../test-utils/fakeWorkspaceDatabase';

const NOW = '2026-08-10T08:00:00.000Z';
const FREE: WorkspacePlanSnapshot = {
  schemaVersion: 2,
  kind: 'free',
  verifiedUntil: '2099-08-10T08:00:00.000Z',
  entitlementExpiresAt: null,
};
const PRO: WorkspacePlanSnapshot = {
  schemaVersion: 2,
  kind: 'pro',
  verifiedUntil: '2099-08-10T08:00:00.000Z',
  entitlementExpiresAt: '2099-09-10T08:00:00.000Z',
};
const STALE_PRO: WorkspacePlanSnapshot = {
  ...PRO,
  verifiedUntil: '2026-08-09T08:00:00.000Z',
};

function ids() {
  let value = 1;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`;
}

function versionInput(index = 1): SaveVersionInput {
  return {
    title: `Backend role ${index}`,
    roleLabel: 'Backend Engineer',
    resumeText: `Built a bounded service ${index}.`,
    score: {
      ...validFixture.score,
      scoreVersion: 'resume-readiness-v1',
      label: 'Strong',
    },
    keywords: ['Python', 'Redis'],
  };
}

function jobInput(index = 1) {
  return {
    companyLabel: `Company ${index}`,
    roleLabel: 'Backend Engineer',
    status: 'saved' as const,
    nextActionAt: null,
    notes: `Follow up ${index}`,
    linkedVersionId: null,
  };
}

function harness(database = new FakeWorkspaceDatabase()) {
  const repository = new WorkspaceRepository({
    openDatabase: async () => database,
    databaseIdentity: database.identity,
    now: () => new Date(NOW),
    idFactory: ids(),
  });
  return { database, repository };
}

describe('private local career workspace', () => {
  it('creates the exact schema and writes a version only after explicit save', async () => {
    const { database, repository } = harness();
    await repository.initialize();

    await expect(repository.listVersions({ before: null, limit: 25 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(database.versions).toEqual([]);

    const saved = await repository.saveVersion(versionInput(), FREE);

    expect(saved.version.title).toBe('Backend role 1');
    expect(saved.snapshot.resumeText).toBe('Built a bounded service 1.');
    expect(database.userVersion).toBe(1);
    expect(database.foreignKeys).toBe(true);
    expect(database.tables).toEqual([
      'jobs',
      'metadata',
      'resume_versions',
      'version_snapshots',
    ]);
  });

  it('enforces Free and stale-plan version limits in the same exclusive transaction', async () => {
    const { database, repository } = harness();
    await repository.initialize();
    await repository.saveVersion(versionInput(1), FREE);
    const callsBefore = database.calls.length;

    await expect(repository.saveVersion(versionInput(2), STALE_PRO))
      .rejects.toBeInstanceOf(WorkspaceStorageError);

    expect(database.versions).toHaveLength(1);
    const calls = database.calls.slice(callsBefore).map(call => call.sql);
    expect(calls[0]).toBe('BEGIN EXCLUSIVE');
    expect(calls).toContain('SELECT COUNT(*) AS count FROM resume_versions');
    expect(calls.some(sql => /^INSERT INTO resume_versions/.test(sql))).toBe(false);
    expect(calls.at(-1)).toBe('ROLLBACK');
  });

  it('allows Pro capacity, adds bounded snapshots, and reads a strict aggregate', async () => {
    const { repository } = harness();
    await repository.initialize();
    const first = await repository.saveVersion(versionInput(1), PRO);
    await repository.saveVersion(versionInput(2), PRO);

    const snapshot = await repository.addSnapshot(first.version.id, {
      resumeText: 'Built a second audited service.',
      score: {
        ...validFixture.score,
        scoreVersion: 'resume-readiness-v1',
        label: 'Strong',
      },
      keywords: ['Python', 'PostgreSQL'],
    });
    const aggregate = await repository.getVersion(first.version.id);

    expect(snapshot.versionId).toBe(first.version.id);
    expect(aggregate?.version.latestSnapshotId).toBe(snapshot.id);
    expect(aggregate?.snapshots.map(value => value.id)).toEqual([
      snapshot.id,
      first.snapshot.id,
    ]);
  });

  it('rolls a version and revision deletion back as one transaction', async () => {
    const { database, repository } = harness();
    await repository.initialize();
    const saved = await repository.saveVersion(versionInput(), FREE);
    database.failNext = /^DELETE FROM version_snapshots/;

    await expect(repository.deleteVersion(saved.version.id))
      .rejects.toBeInstanceOf(WorkspaceStorageError);

    expect(database.versions).toHaveLength(1);
    expect(database.snapshots).toHaveLength(1);
  });

  it('uses stable keyset pages for equal timestamps', async () => {
    const { database, repository } = harness();
    await repository.initialize();
    for (let index = 0; index < 53; index += 1) {
      await repository.saveVersion(versionInput(index + 1), PRO);
    }

    const first = await repository.listVersions({ before: null, limit: 25 });
    const second = await repository.listVersions({ before: first.nextCursor, limit: 25 });
    const third = await repository.listVersions({ before: second.nextCursor, limit: 25 });
    const ids = [...first.items, ...second.items, ...third.items].map(item => item.id);

    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(25);
    expect(third.items).toHaveLength(3);
    expect(new Set(ids).size).toBe(53);
    expect(database.calls.some(call =>
      call.sql.includes('(updated_at < ? OR (updated_at = ? AND id < ?))'),
    )).toBe(true);
  });

  it('enforces Free job capacity while allowing updates to an existing job', async () => {
    const { repository } = harness();
    await repository.initialize();
    const first = await repository.saveJob(jobInput(1), FREE);
    await repository.saveJob(jobInput(2), FREE);
    await repository.saveJob(jobInput(3), FREE);

    await expect(repository.saveJob(jobInput(4), FREE))
      .rejects.toBeInstanceOf(WorkspaceStorageError);
    await expect(repository.saveJob({
      ...jobInput(1),
      id: first.id,
      status: 'interviewing',
    }, STALE_PRO)).resolves.toMatchObject({ id: first.id, status: 'interviewing' });
  });

  it('rejects NUL and lone-surrogate content before issuing a write', async () => {
    const { database, repository } = harness();
    await repository.initialize();
    const callsBefore = database.calls.length;

    await expect(repository.saveVersion({
      ...versionInput(),
      resumeText: 'private\u0000resume',
    }, PRO)).rejects.toBeInstanceOf(WorkspaceStorageError);
    await expect(repository.saveJob({
      ...jobInput(),
      notes: 'private\ud800note',
    }, PRO)).rejects.toBeInstanceOf(WorkspaceStorageError);

    expect(database.calls.slice(callsBefore).some(call => /^INSERT|^UPDATE/.test(call.sql)))
      .toBe(false);
  });

  it('deletes all local workspace content with truthful committed counts', async () => {
    const { repository } = harness();
    await repository.initialize();
    const version = await repository.saveVersion(versionInput(), PRO);
    const added: AddSnapshotInput = {
      resumeText: 'Built a second local version.',
      score: versionInput().score,
      keywords: ['Python'],
    };
    await repository.addSnapshot(version.version.id, added);
    await repository.saveJob({ ...jobInput(), linkedVersionId: version.version.id }, PRO);

    await expect(repository.deleteAll()).resolves.toEqual({
      deletedVersions: 1,
      deletedSnapshots: 2,
      deletedJobs: 1,
      failures: 0,
    });
    await expect(repository.listVersions({ before: null, limit: 25 }))
      .resolves.toMatchObject({ items: [] });
    await expect(repository.listJobs({ before: null, limit: 25 }))
      .resolves.toMatchObject({ items: [] });
  });
});
