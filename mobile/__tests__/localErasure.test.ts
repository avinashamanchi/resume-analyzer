import {
  LocalErasureCoordinator,
  LocalErasureError,
  type LocalErasureJournalPort,
} from '../src/privacy/localErasure';

function harness(initial: string | null = null) {
  let value = initial;
  const journal: LocalErasureJournalPort = {
    read: jest.fn(async () => value),
    write: jest.fn(async next => { value = next; }),
    clear: jest.fn(async () => { value = null; }),
  };
  const dependencies = {
    journal,
    resetSession: jest.fn(async () => undefined),
    deleteReports: jest.fn(async () => undefined),
    deleteWorkspace: jest.fn(async () => undefined),
  };
  return { journal, dependencies, persisted: () => value };
}

describe('crash-recoverable local erasure', () => {
  it('persists content-free phase progress and resumes only unfinished stores', async () => {
    const setup = harness();
    setup.dependencies.deleteWorkspace
      .mockRejectedValueOnce(new Error('workspace unavailable'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new LocalErasureCoordinator(setup.dependencies);

    await expect(coordinator.eraseAll()).rejects.toBeInstanceOf(LocalErasureError);
    expect(JSON.parse(setup.persisted()!)).toEqual({
      schemaVersion: 1,
      sessionCleared: true,
      reportsCleared: true,
      workspaceCleared: false,
    });

    await expect(coordinator.resume()).resolves.toEqual({ completed: true });
    expect(setup.dependencies.resetSession).toHaveBeenCalledTimes(1);
    expect(setup.dependencies.deleteReports).toHaveBeenCalledTimes(1);
    expect(setup.dependencies.deleteWorkspace).toHaveBeenCalledTimes(2);
    expect(setup.journal.clear).toHaveBeenCalledTimes(1);
    expect(setup.persisted()).toBeNull();
  });

  it('fails closed on malformed or expanded journal data before deleting anything', async () => {
    const setup = harness(JSON.stringify({
      schemaVersion: 1,
      sessionCleared: false,
      reportsCleared: false,
      workspaceCleared: false,
      privateContent: 'must-not-be-accepted',
    }));
    const coordinator = new LocalErasureCoordinator(setup.dependencies);

    await expect(coordinator.resume()).rejects.toBeInstanceOf(LocalErasureError);
    expect(setup.dependencies.resetSession).not.toHaveBeenCalled();
    expect(setup.dependencies.deleteReports).not.toHaveBeenCalled();
    expect(setup.dependencies.deleteWorkspace).not.toHaveBeenCalled();
    expect(setup.journal.clear).not.toHaveBeenCalled();
  });

  it('does not delete any store when the pending journal cannot be durably written', async () => {
    const setup = harness();
    jest.mocked(setup.journal.write).mockRejectedValueOnce(new Error('keychain unavailable'));
    const coordinator = new LocalErasureCoordinator(setup.dependencies);

    await expect(coordinator.eraseAll()).rejects.toBeInstanceOf(LocalErasureError);
    expect(setup.dependencies.resetSession).not.toHaveBeenCalled();
    expect(setup.dependencies.deleteReports).not.toHaveBeenCalled();
    expect(setup.dependencies.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('coalesces concurrent erasure requests into one serialized operation', async () => {
    const setup = harness();
    const coordinator = new LocalErasureCoordinator(setup.dependencies);

    const first = coordinator.eraseAll();
    const second = coordinator.eraseAll();

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { completed: true },
      { completed: true },
    ]);
    expect(setup.dependencies.resetSession).toHaveBeenCalledTimes(1);
    expect(setup.dependencies.deleteReports).toHaveBeenCalledTimes(1);
    expect(setup.dependencies.deleteWorkspace).toHaveBeenCalledTimes(1);
  });
});
