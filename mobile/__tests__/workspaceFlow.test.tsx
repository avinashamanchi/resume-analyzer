import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import CompareScreen from '../app/compare';
import JobDetailScreen from '../app/jobs/[jobId]';
import JobsScreen from '../app/jobs';
import VersionsScreen from '../app/versions';
import type {
  JobRecord,
  ResumeVersion,
  VersionSnapshot,
  WorkspacePlanSnapshot,
  WorkspaceCursor,
} from '../src/workspace/contracts';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockSearchParams: Readonly<Record<string, string>> = {};
let mockWorkspaceData: any;
let mockController: any;
let mockBilling: any;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace }),
  useLocalSearchParams: () => mockSearchParams,
}));
jest.mock('../src/workspace/WorkspaceProvider', () => ({
  useWorkspaceData: () => mockWorkspaceData,
}));
jest.mock('../src/controllers/AppController', () => ({
  useAppController: () => mockController,
}));
jest.mock('../src/billing/BillingProvider', () => ({
  useBilling: () => mockBilling,
}));

const VERIFIED_FREE = Object.freeze({
  schemaVersion: 2 as const,
  kind: 'free' as const,
  verifiedUntil: '2099-08-11T00:00:00.000Z',
  entitlementExpiresAt: null,
  allowance: { used: 0, limit: 3 as const, resetsAt: '2099-09-01T00:00:00.000Z' },
});

const VERIFIED_PRO = Object.freeze({
  schemaVersion: 2 as const,
  kind: 'pro' as const,
  verifiedUntil: '2099-08-11T00:00:00.000Z',
  entitlementExpiresAt: '2099-09-11T00:00:00.000Z',
  allowance: { used: 4, limit: 100 as const, resetsAt: '2099-09-01T00:00:00.000Z' },
});

const WORKSPACE_FREE: WorkspacePlanSnapshot = {
  schemaVersion: 2,
  kind: 'free',
  verifiedUntil: VERIFIED_FREE.verifiedUntil,
  entitlementExpiresAt: null,
};

const SCORE: VersionSnapshot['score'] = {
  ...validFixture.score,
  scoreVersion: 'resume-readiness-v1' as const,
  label: 'Strong',
};

const VERSION_ONE: ResumeVersion = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Backend version',
  roleLabel: 'Backend Engineer',
  createdAt: '2026-08-09T10:00:00.000Z',
  updatedAt: '2026-08-09T10:00:00.000Z',
  latestSnapshotId: '22222222-2222-4222-8222-222222222222',
};

const VERSION_TWO: ResumeVersion = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Platform version',
  roleLabel: 'Platform Engineer',
  createdAt: '2026-08-09T11:00:00.000Z',
  updatedAt: '2026-08-09T11:00:00.000Z',
  latestSnapshotId: '44444444-4444-4444-8444-444444444444',
};

const VERSION_THREE: ResumeVersion = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Leadership version',
  roleLabel: 'Engineering Manager',
  createdAt: '2026-08-09T12:00:00.000Z',
  updatedAt: '2026-08-09T12:00:00.000Z',
  latestSnapshotId: '77777777-7777-4777-8777-777777777777',
};

const SNAPSHOT_ONE: VersionSnapshot = {
  id: VERSION_ONE.latestSnapshotId,
  versionId: VERSION_ONE.id,
  createdAt: VERSION_ONE.createdAt,
  resumeText: 'Built backend services.',
  score: {
    ...SCORE,
    readinessScore: 80,
    label: 'Good' as const,
    components: { ...SCORE.components, keywords: 10 },
  },
  keywords: ['Python'],
};

const SNAPSHOT_TWO: VersionSnapshot = {
  id: VERSION_TWO.latestSnapshotId,
  versionId: VERSION_TWO.id,
  createdAt: VERSION_TWO.createdAt,
  resumeText: 'Built backend services.\nAdded measurable impact.',
  score: SCORE,
  keywords: ['Python', 'Redis'],
};

const SNAPSHOT_THREE: VersionSnapshot = {
  id: VERSION_THREE.latestSnapshotId,
  versionId: VERSION_THREE.id,
  createdAt: VERSION_THREE.createdAt,
  resumeText: 'Led a platform team.\nAdded measurable impact.',
  score: SCORE,
  keywords: ['Leadership', 'Redis'],
};

const OLDER_CURSOR: WorkspaceCursor = {
  schemaVersion: 1,
  updatedAt: VERSION_TWO.updatedAt,
  id: VERSION_TWO.id,
};

const JOB: JobRecord = {
  id: '55555555-5555-4555-8555-555555555555',
  companyLabel: 'Example Co',
  roleLabel: 'Staff Engineer',
  status: 'saved',
  nextActionAt: null,
  notes: 'Review the role.',
  linkedVersionId: null,
  createdAt: '2026-08-09T12:00:00.000Z',
  updatedAt: '2026-08-09T12:00:00.000Z',
};

const JOB_TWO: JobRecord = {
  ...JOB,
  id: '88888888-8888-4888-8888-888888888888',
  companyLabel: 'Older Co',
  roleLabel: 'Backend Engineer',
  updatedAt: '2026-08-09T11:00:00.000Z',
};

const JOB_CURSOR: WorkspaceCursor = {
  schemaVersion: 1,
  updatedAt: JOB.updatedAt,
  id: JOB.id,
};

const originalFetch = global.fetch;

function repository(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    databaseIdentity: 'test-workspace',
    initialize: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    saveVersion: jest.fn(async () => ({ version: VERSION_ONE, snapshot: SNAPSHOT_ONE })),
    addSnapshot: jest.fn(async () => SNAPSHOT_TWO),
    listVersions: jest.fn(async () => ({ items: [], nextCursor: null })),
    getVersion: jest.fn(async () => null),
    deleteVersion: jest.fn(async () => true),
    saveJob: jest.fn(async () => JOB),
    listJobs: jest.fn(async () => ({ items: [], nextCursor: null })),
    getJob: jest.fn(async () => JOB),
    deleteJob: jest.fn(async () => true),
    deleteAll: jest.fn(async () => ({ deletedVersions: 0, deletedSnapshots: 0, deletedJobs: 0, failures: 0 })),
    ...overrides,
  };
}

describe('private local career workspace flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as typeof fetch;
    mockSearchParams = {};
    mockBilling = {
      verifiedPlan: VERIFIED_FREE,
      entitlementActive: false,
    };
    mockController = {
      analysis: {
        state: {
          source: { kind: 'pasted_text', text: 'Reviewed resume text.' },
          result: validFixture,
        },
      },
    };
    mockWorkspaceData = { status: 'ready', repository: repository() };
  });

  afterAll(() => { global.fetch = originalFetch; });

  it('does not persist a resume version until the explicit save and trims labels', async () => {
    const view = render(<VersionsScreen />);
    await waitFor(() => expect(mockWorkspaceData.repository.listVersions).toHaveBeenCalled());
    expect(mockWorkspaceData.repository.saveVersion).not.toHaveBeenCalled();

    fireEvent.changeText(view.getByLabelText('Version title'), '  Backend version  ');
    fireEvent.changeText(view.getByLabelText('Target role'), '  Backend Engineer  ');
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Save version on this device' }));
    });

    expect(mockWorkspaceData.repository.saveVersion).toHaveBeenCalledWith({
      title: 'Backend version',
      roleLabel: 'Backend Engineer',
      resumeText: 'Reviewed resume text.',
      score: validFixture.score,
      keywords: validFixture.feedback.matchedKeywords,
    }, WORKSPACE_FREE);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('saves a manually entered job locally only after the explicit action', async () => {
    mockWorkspaceData = {
      status: 'ready',
      repository: repository({
        listVersions: jest.fn(async () => ({ items: [VERSION_ONE], nextCursor: null })),
      }),
    };
    const view = render(<JobsScreen />);
    await waitFor(() => expect(mockWorkspaceData.repository.listJobs).toHaveBeenCalled());
    expect(mockWorkspaceData.repository.saveJob).not.toHaveBeenCalled();

    fireEvent.changeText(view.getByLabelText('Company'), '  Example Co  ');
    fireEvent.changeText(view.getByLabelText('Role'), '  Staff Engineer  ');
    fireEvent.changeText(view.getByLabelText('Job notes'), 'Review the role.');
    fireEvent.changeText(view.getByLabelText('Next action date'), '2026-08-30');
    fireEvent.press(view.getByRole('button', { name: 'Link Backend version' }));
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Save job on this device' }));
    });

    expect(mockWorkspaceData.repository.saveJob).toHaveBeenCalledWith({
      companyLabel: 'Example Co',
      roleLabel: 'Staff Engineer',
      status: 'saved',
      nextActionAt: '2026-08-30T12:00:00.000Z',
      notes: 'Review the role.',
      linkedVersionId: VERSION_ONE.id,
    }, WORKSPACE_FREE);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('pages resume-version labels without loading resume bodies', async () => {
    const listVersions = jest.fn(async ({ before }: { before: WorkspaceCursor | null }) => before === null
      ? { items: [VERSION_THREE], nextCursor: OLDER_CURSOR }
      : { items: [VERSION_ONE], nextCursor: null });
    mockWorkspaceData = { status: 'ready', repository: repository({ listVersions }) };
    const view = render(<VersionsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Open Leadership version' })).toBeTruthy());
    expect(mockWorkspaceData.repository.getVersion).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Load older resume versions' }));
    });

    await waitFor(() => expect(view.getByRole('button', { name: 'Open Backend version' })).toBeTruthy());
    expect(listVersions).toHaveBeenNthCalledWith(1, { before: null, limit: 25 });
    expect(listVersions).toHaveBeenNthCalledWith(2, { before: OLDER_CURSOR, limit: 25 });
    expect(mockWorkspaceData.repository.getVersion).not.toHaveBeenCalled();
  });

  it('pages job labels without a network request', async () => {
    const listJobs = jest.fn(async ({ before }: { before: WorkspaceCursor | null }) => before === null
      ? { items: [JOB], nextCursor: JOB_CURSOR }
      : { items: [JOB_TWO], nextCursor: null });
    mockWorkspaceData = { status: 'ready', repository: repository({ listJobs }) };
    const view = render(<JobsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Open Staff Engineer at Example Co' })).toBeTruthy());
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Load older jobs' }));
    });

    await waitFor(() => expect(view.getByRole('button', { name: 'Open Backend Engineer at Older Co' })).toBeTruthy());
    expect(listJobs).toHaveBeenNthCalledWith(1, { before: null, limit: 25 });
    expect(listJobs).toHaveBeenNthCalledWith(2, { before: JOB_CURSOR, limit: 25 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('updates an existing job status without network access', async () => {
    mockSearchParams = { jobId: JOB.id };
    const view = render(<JobDetailScreen />);
    await waitFor(() => expect(view.getByText('Staff Engineer')).toBeTruthy());

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Mark applied' }));
    });

    expect(mockWorkspaceData.repository.saveJob).toHaveBeenCalledWith({
      id: JOB.id,
      companyLabel: JOB.companyLabel,
      roleLabel: JOB.roleLabel,
      status: 'applied',
      nextActionAt: null,
      notes: JOB.notes,
      linkedVersionId: null,
    }, WORKSPACE_FREE);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('compares the latest two saved versions with bounded local data only', async () => {
    mockBilling = { verifiedPlan: VERIFIED_PRO, entitlementActive: true };
    mockWorkspaceData = {
      status: 'ready',
      repository: repository({
        listVersions: jest.fn(async () => ({ items: [VERSION_TWO, VERSION_ONE], nextCursor: null })),
        getVersion: jest.fn(async (id: string) => id === VERSION_ONE.id
          ? { version: VERSION_ONE, snapshots: [SNAPSHOT_ONE] }
          : { version: VERSION_TWO, snapshots: [SNAPSHOT_TWO] }),
      }),
    };
    const view = render(<CompareScreen />);

    await waitFor(() => expect(view.getByText('Backend version → Platform version')).toBeTruthy());
    expect(view.getByText('Total score: +5')).toBeTruthy();
    expect(view.getByText('Added: Redis')).toBeTruthy();
    expect(view.getByText('+ Added measurable impact.')).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('lets Free compare its one saved version with the current unsaved analysis', async () => {
    mockWorkspaceData = {
      status: 'ready',
      repository: repository({
        listVersions: jest.fn(async () => ({ items: [VERSION_ONE], nextCursor: null })),
        getVersion: jest.fn(async () => ({ version: VERSION_ONE, snapshots: [SNAPSHOT_ONE] })),
      }),
    };
    const view = render(<CompareScreen />);

    await waitFor(() => expect(view.getByText('Backend version → Current unsaved analysis')).toBeTruthy());
    expect(view.getByText('Total score: +5')).toBeTruthy();
    expect(view.getByText('Added: Flask')).toBeTruthy();
    expect(view.getByText(/current reviewed analysis remains unsaved/i)).toBeTruthy();
    expect(mockWorkspaceData.repository.saveVersion).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('lets verified Pro page through versions and choose any two saved candidates', async () => {
    mockBilling = { verifiedPlan: VERIFIED_PRO, entitlementActive: true };
    const listVersions = jest.fn(async ({ before }: { before: WorkspaceCursor | null }) => before === null
      ? { items: [VERSION_THREE, VERSION_TWO], nextCursor: OLDER_CURSOR }
      : { items: [VERSION_ONE], nextCursor: null });
    mockWorkspaceData = {
      status: 'ready',
      repository: repository({
        listVersions,
        getVersion: jest.fn(async (id: string) => id === VERSION_ONE.id
          ? { version: VERSION_ONE, snapshots: [SNAPSHOT_ONE] }
          : id === VERSION_TWO.id
            ? { version: VERSION_TWO, snapshots: [SNAPSHOT_TWO] }
            : { version: VERSION_THREE, snapshots: [SNAPSHOT_THREE] }),
      }),
    };
    const view = render(<CompareScreen />);

    await waitFor(() => expect(view.getByText('Platform version → Leadership version')).toBeTruthy());
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Load older versions' }));
    });
    await waitFor(() => expect(view.getByRole('button', { name: 'Use Backend version as first version' })).toBeTruthy());
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Use Backend version as first version' }));
    });

    await waitFor(() => expect(view.getByText('Backend version → Leadership version')).toBeTruthy());
    expect(listVersions).toHaveBeenNthCalledWith(1, { before: null, limit: 25 });
    expect(listVersions).toHaveBeenNthCalledWith(2, { before: OLDER_CURSOR, limit: 25 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not unlock Pro workspace behavior from an unverified client entitlement', async () => {
    mockBilling = { verifiedPlan: VERIFIED_FREE, entitlementActive: true };
    mockWorkspaceData = {
      status: 'ready',
      repository: repository({
        listVersions: jest.fn(async () => ({ items: [VERSION_TWO, VERSION_ONE], nextCursor: null })),
        getVersion: jest.fn(async (id: string) => id === VERSION_ONE.id
          ? { version: VERSION_ONE, snapshots: [SNAPSHOT_ONE] }
          : { version: VERSION_TWO, snapshots: [SNAPSHOT_TWO] }),
      }),
    };

    const view = render(<CompareScreen />);

    await waitFor(() => expect(view.getByText('Platform version → Current unsaved analysis')).toBeTruthy());
    expect(view.queryByText('Choose two saved versions')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses the verified Free cap message when a stale client entitlement cannot save', async () => {
    const saveVersion = jest.fn(async () => { throw new Error('verified free cap'); });
    mockBilling = { verifiedPlan: VERIFIED_FREE, entitlementActive: true };
    mockWorkspaceData = { status: 'ready', repository: repository({ saveVersion }) };
    const view = render(<VersionsScreen />);
    await waitFor(() => expect(mockWorkspaceData.repository.listVersions).toHaveBeenCalled());

    fireEvent.changeText(view.getByLabelText('Version title'), 'Another version');
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Save version on this device' }));
    });

    expect(view.getByText('Free includes one saved version. Upgrade to Pro for more versions.')).toBeTruthy();
  });
});
