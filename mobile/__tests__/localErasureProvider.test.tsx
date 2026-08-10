import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import { AppControllerProvider } from '../src/controllers/AppController';
import {
  LocalErasureProvider,
  useLocalErasure,
} from '../src/privacy/LocalErasureProvider';
import type { LocalErasureJournalPort } from '../src/privacy/localErasure';
import {
  WorkspaceProvider,
  createWorkspaceLifecycleCoordinator,
} from '../src/workspace/WorkspaceProvider';

function memoryJournal(initial: string | null = null): LocalErasureJournalPort {
  let value = initial;
  return {
    read: jest.fn(async () => value),
    write: jest.fn(async next => { value = next; }),
    clear: jest.fn(async () => { value = null; }),
  };
}

function workspaceRepository(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    databaseIdentity: 'test-workspace',
    initialize: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    saveVersion: jest.fn(), addSnapshot: jest.fn(), listVersions: jest.fn(),
    getVersion: jest.fn(), deleteVersion: jest.fn(), saveJob: jest.fn(),
    listJobs: jest.fn(), getJob: jest.fn(), deleteJob: jest.fn(),
    deleteAll: jest.fn(async () => ({
      deletedVersions: 1,
      deletedSnapshots: 2,
      deletedJobs: 3,
      failures: 0 as const,
    })),
    ...overrides,
  } as any;
}

function controller() {
  return {
    actions: {
      pickPdfForDisplay: jest.fn(), resetConsent: jest.fn(), cleanupCache: jest.fn(),
      shareSummary: jest.fn(), openSupport: jest.fn(), serviceAvailable: true, appVersion: '1.0.0',
    },
    analysis: {
      state: { result: null },
      commands: { reset: jest.fn(async () => undefined) },
    } as any,
    history: {
      status: 'ready', reports: [], reportCount: 0, hasMore: false, hasNewer: false,
      loadingMore: false, error: null, load: jest.fn(), loadMore: jest.fn(),
      returnToNewest: jest.fn(), saveCurrent: jest.fn(), get: jest.fn(), delete: jest.fn(),
      deleteAll: jest.fn(async () => ({ deletedReports: 4, deletedTempFiles: 1, failures: 0 })),
    } as any,
  };
}

function Probe() {
  const erasure = useLocalErasure();
  return (
    <>
      <Text testID="erasure-status">{`${erasure.status}:${erasure.busy}`}</Text>
      <Text testID="erasure-message">{erasure.message ?? ''}</Text>
      <Pressable accessibilityRole="button" onPress={() => { void erasure.eraseAll(); }}>
        <Text>Erase all local data</Text>
      </Pressable>
    </>
  );
}

function tree(
  context: ReturnType<typeof controller>,
  repository: ReturnType<typeof workspaceRepository>,
  journal: LocalErasureJournalPort,
) {
  return (
    <AppControllerProvider value={context}>
      <WorkspaceProvider
        createRepository={() => repository}
        databaseIdentity="test-workspace"
        lifecycleCoordinator={createWorkspaceLifecycleCoordinator()}>
        <LocalErasureProvider journal={journal}>
          <Probe />
        </LocalErasureProvider>
      </WorkspaceProvider>
    </AppControllerProvider>
  );
}

describe('local erasure lifecycle provider', () => {
  it('clears session, report/temp data, and workspace data from one explicit action', async () => {
    const context = controller();
    const repository = workspaceRepository();
    const view = render(tree(context, repository, memoryJournal()));
    await waitFor(() => expect(view.getByTestId('erasure-status').props.children).toBe('ready:false'));

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Erase all local data' }));
    });

    await waitFor(() => expect(view.getByTestId('erasure-message').props.children)
      .toBe('All active local data stores were verified as cleared.'));
    expect(context.analysis.commands.reset).toHaveBeenCalledTimes(1);
    expect(context.history.deleteAll).toHaveBeenCalledTimes(1);
    expect(repository.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('automatically finishes a pending workspace phase after relaunch', async () => {
    const pending = JSON.stringify({
      schemaVersion: 1,
      sessionCleared: true,
      reportsCleared: true,
      workspaceCleared: false,
    });
    const context = controller();
    const repository = workspaceRepository();
    const view = render(tree(context, repository, memoryJournal(pending)));

    await waitFor(() => expect(view.getByTestId('erasure-status').props.children).toBe('ready:false'));
    expect(context.analysis.commands.reset).not.toHaveBeenCalled();
    expect(context.history.deleteAll).not.toHaveBeenCalled();
    expect(repository.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('blocks erasure without touching reports when the workspace cannot open safely', async () => {
    const context = controller();
    const repository = workspaceRepository({
      initialize: jest.fn(async () => { throw new Error('corrupt database'); }),
    });
    const view = render(tree(context, repository, memoryJournal()));

    await waitFor(() => expect(view.getByTestId('erasure-status').props.children).toBe('blocked:false'));
    expect(context.analysis.commands.reset).not.toHaveBeenCalled();
    expect(context.history.deleteAll).not.toHaveBeenCalled();
    expect(repository.deleteAll).not.toHaveBeenCalled();
  });
});
