import { act, render, waitFor } from '@testing-library/react-native';
import React, { StrictMode } from 'react';
import { Text } from 'react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import {
  DataProvider,
  createReportLifecycleCoordinator,
  type ReportLifecycleCoordinator,
  useReportData,
} from '../src/storage/DataProvider';
import {
  REPORT_DATABASE_IDENTITY,
  ReportRepository,
  type ReportRepositoryPort,
} from '../src/storage/reportRepository';

import { FakeReportDatabase } from '../test-utils/fakeReportDatabase';

const DETAILED_CLEAN = {
  attempted: 0,
  deleted: 0,
  failed: 0,
  refused: 0,
  deletedFiles: 0,
  live: 0,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function lifecycleRepository(
  initialize: () => Promise<void>,
  close: () => Promise<void>,
  databaseIdentity = REPORT_DATABASE_IDENTITY,
): ReportRepositoryPort {
  return {
    databaseIdentity,
    initialize,
    save: async () => { throw new Error('not used'); },
    list: async () => [],
    get: async () => null,
    delete: async () => 0,
    deleteAll: async () => ({ deletedReports: 0, deletedTempFiles: 0, failures: 0 }),
    close,
  };
}

function Probe() {
  const data = useReportData();
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Text, { testID: 'status' }, data.status),
    React.createElement(
      Text,
      { testID: 'repository' },
      data.status === 'ready' && data.repository ? 'ready' : 'hidden',
    ),
  );
}

describe('local history privacy', () => {
  let lifecycleCoordinator: ReportLifecycleCoordinator;

  beforeEach(() => {
    lifecycleCoordinator = createReportLifecycleCoordinator();
  });

  it('persists only the allowlisted report projection', async () => {
    const database = new FakeReportDatabase();
    const repository = new ReportRepository({
      openDatabase: async () => database,
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
      now: () => new Date('2026-08-05T19:20:30.000Z'),
    });
    await repository.initialize();

    await repository.save({
      result: validFixture,
      source: { kind: 'pdf', uri: 'file:///private/Private Name.pdf' },
      filename: 'Private Name.pdf',
      resumeText: 'private resume marker',
      jobDescription: 'private job marker',
      installationToken: 'private token marker',
      requestId: 'private request marker',
      rawResponse: 'private response marker',
    });

    const serializedRows = JSON.stringify(database.rows);
    const serializedSql = JSON.stringify(database.calls);
    for (const secret of [
      'Private Name.pdf',
      'private resume marker',
      'private job marker',
      'private token marker',
      'private request marker',
      'private response marker',
      'file:///private',
    ]) {
      expect(serializedRows).not.toContain(secret);
      expect(serializedSql).not.toContain(secret);
    }
    expect(Object.keys(database.rows[0]).sort()).toEqual([
      'created_at',
      'feedback_json',
      'id',
      'schema_version',
      'score_json',
      'source_type',
      'title',
    ]);
  });

  it('never places native causes or report content in errors or console output', async () => {
    const privateCause = 'Private Name.pdf private resume native cause';
    const database = FakeReportDatabase.versionOne();
    database.failNext = /^SELECT .* FROM reports ORDER BY/;
    const repository = new ReportRepository({
      openDatabase: async () => database,
      tempFiles: { cleanupAbandonedDetailed: async () => { throw new Error(privateCause); } },
    });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnLog = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await repository.initialize();

    const error = await repository.list().catch(reason => reason as unknown);

    expect(String(error)).toBe('LocalStorageError: Local report storage could not complete the operation.');
    expect(JSON.stringify(error)).not.toContain(privateCause);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateCause);
    expect(JSON.stringify(warnLog.mock.calls)).not.toContain(privateCause);
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  it('exposes the repository only after initialization and closes on unmount', async () => {
    const database = new FakeReportDatabase();
    let releaseOpen!: () => void;
    const openBarrier = new Promise<void>(resolve => { releaseOpen = resolve; });
    const repository = new ReportRepository({
      openDatabase: async () => {
        await openBarrier;
        return database;
      },
      tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
    });
    const view = await render(React.createElement(
      DataProvider,
      { createRepository: () => repository, lifecycleCoordinator },
      React.createElement(Probe),
    ));

    expect(view.getByTestId('repository').props.children).toBe('hidden');
    await act(async () => { releaseOpen(); });
    await waitFor(() => expect(view.getByTestId('status').props.children).toBe('ready'));
    expect(view.getByTestId('repository').props.children).toBe('ready');

    await view.unmount();
    await act(async () => { await repository.close(); });
    expect(database.closeCount).toBe(1);
  });

  it('uses independent repository ownership across StrictMode effect restarts', async () => {
    const databases: FakeReportDatabase[] = [];
    const repositories: ReportRepository[] = [];
    const view = await render(React.createElement(
      StrictMode,
      null,
      React.createElement(
        DataProvider,
        { lifecycleCoordinator, createRepository: () => {
          const database = new FakeReportDatabase();
          const repository = new ReportRepository({
            openDatabase: async () => database,
            tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
          });
          databases.push(database);
          repositories.push(repository);
          return repository;
        } },
        React.createElement(Probe),
      ),
    ));

    await waitFor(() => expect(view.getByTestId('status').props.children).toBe('ready'));
    expect(repositories.length).toBeGreaterThanOrEqual(2);
    expect(databases.slice(0, -1).every(database => database.closeCount === 1)).toBe(true);
    expect(databases.at(-1)?.closeCount).toBe(0);

    await view.unmount();
    await act(async () => { await Promise.all(repositories.map(repository => repository.close())); });
    expect(databases.every(database => database.closeCount === 1)).toBe(true);
  });

  it('does not initialize a StrictMode replacement until the discarded repository closes', async () => {
    const closing = deferred<void>();
    const initializeCalls = [0, 0];
    const repositories = [
      lifecycleRepository(async () => { initializeCalls[0] += 1; }, () => closing.promise),
      lifecycleRepository(async () => { initializeCalls[1] += 1; }, async () => undefined),
    ];
    let created = 0;
    const view = await render(React.createElement(
      StrictMode,
      null,
      React.createElement(
        DataProvider,
        { createRepository: () => repositories[created++], lifecycleCoordinator },
        React.createElement(Probe),
      ),
    ));

    expect(created).toBe(1);
    expect(initializeCalls[1]).toBe(0);
    expect(view.getByTestId('status').props.children).toBe('loading');
    await act(async () => { closing.resolve(); });
    await waitFor(() => expect(view.getByTestId('status').props.children).toBe('ready'));
    expect(created).toBe(2);
    expect(initializeCalls[1]).toBe(1);
    await view.unmount();
  });

  it('blocks a StrictMode replacement when the discarded repository cannot close', async () => {
    const initializeCalls = [0, 0];
    const repositories = [
      lifecycleRepository(
        async () => { initializeCalls[0] += 1; },
        async () => { throw new Error('private close cause'); },
      ),
      lifecycleRepository(async () => { initializeCalls[1] += 1; }, async () => undefined),
    ];
    let created = 0;
    const view = await render(React.createElement(
      StrictMode,
      null,
      React.createElement(
        DataProvider,
        { createRepository: () => repositories[created++], lifecycleCoordinator },
        React.createElement(Probe),
      ),
    ));

    await waitFor(() => expect(view.getByTestId('status').props.children).toBe('blocked'));
    expect(view.getByTestId('repository').props.children).toBe('hidden');
    expect(created).toBe(1);
    expect(initializeCalls[1]).toBe(0);
    await view.unmount();
  });

  it('holds a separately mounted provider until the prior mount closes the same database', async () => {
    const closingStarted = deferred<void>();
    const closing = deferred<void>();
    const repositories = [
      lifecycleRepository(
        async () => undefined,
        () => {
          closingStarted.resolve();
          return closing.promise;
        },
      ),
      lifecycleRepository(async () => undefined, async () => undefined),
      lifecycleRepository(async () => undefined, async () => undefined),
    ];
    let created = 0;
    const firstView = await render(React.createElement(
      DataProvider,
      { createRepository: () => repositories[created++], lifecycleCoordinator },
      React.createElement(Probe),
    ));
    await waitFor(() => expect(firstView.getByTestId('status').props.children).toBe('ready'));
    await firstView.unmount();
    await closingStarted.promise;

    const secondView = await render(React.createElement(
      DataProvider,
      { createRepository: () => repositories[created++], lifecycleCoordinator },
      React.createElement(Probe),
    ));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const createdBeforeClose = created;
    const statusBeforeClose = secondView.getByTestId('status').props.children;
    closing.resolve();
    await waitFor(() => expect(secondView.getByTestId('status').props.children).toBe('ready'));

    expect(createdBeforeClose).toBe(1);
    expect(statusBeforeClose).toBe('loading');
    expect(created).toBe(2);
    await secondView.unmount();

    const thirdView = await render(React.createElement(
      DataProvider,
      { createRepository: () => repositories[created++], lifecycleCoordinator },
      React.createElement(Probe),
    ));
    await waitFor(() => expect(thirdView.getByTestId('status').props.children).toBe('ready'));
    expect(created).toBe(3);
    await thirdView.unmount();
  });

  it('blocks a separately mounted provider when the prior database close rejects', async () => {
    const closeAttempted = deferred<void>();
    const repositories = [
      lifecycleRepository(
        async () => undefined,
        async () => {
          closeAttempted.resolve();
          throw new Error('private cross-mount close cause');
        },
      ),
      lifecycleRepository(async () => undefined, async () => undefined),
    ];
    let created = 0;
    const firstView = await render(React.createElement(
      DataProvider,
      { createRepository: () => repositories[created++], lifecycleCoordinator },
      React.createElement(Probe),
    ));
    await waitFor(() => expect(firstView.getByTestId('status').props.children).toBe('ready'));
    await firstView.unmount();
    await closeAttempted.promise;

    const secondView = await render(React.createElement(
      DataProvider,
      { createRepository: () => repositories[created++], lifecycleCoordinator },
      React.createElement(Probe),
    ));
    await waitFor(() => {
      expect(secondView.getByTestId('status').props.children).not.toBe('loading');
    });

    expect(secondView.getByTestId('status').props.children).toBe('blocked');
    expect(secondView.getByTestId('repository').props.children).toBe('hidden');
    expect(created).toBe(1);
    await secondView.unmount();
  });

  it('does not block a provider that owns a different physical database identity', async () => {
    const closingStarted = deferred<void>();
    const closing = deferred<void>();
    const firstIdentity = 'file:///app/sqlite/first-provider.db';
    const secondIdentity = 'file:///app/sqlite/second-provider.db';
    const firstRepository = lifecycleRepository(
      async () => undefined,
      () => {
        closingStarted.resolve();
        return closing.promise;
      },
      firstIdentity,
    );
    const secondRepository = lifecycleRepository(
      async () => undefined,
      async () => undefined,
      secondIdentity,
    );
    const firstView = await render(React.createElement(
      DataProvider,
      {
        createRepository: () => firstRepository,
        databaseIdentity: firstIdentity,
        lifecycleCoordinator,
      },
      React.createElement(Probe),
    ));
    await waitFor(() => expect(firstView.getByTestId('status').props.children).toBe('ready'));
    await firstView.unmount();
    await closingStarted.promise;

    const secondView = await render(React.createElement(
      DataProvider,
      {
        createRepository: () => secondRepository,
        databaseIdentity: secondIdentity,
        lifecycleCoordinator,
      },
      React.createElement(Probe),
    ));
    await waitFor(() => expect(secondView.getByTestId('status').props.children).toBe('ready'));
    expect(secondView.getByTestId('repository').props.children).toBe('ready');

    closing.resolve();
    await secondView.unmount();
  });

  it('blocks on initialization failure without surfacing raw errors', async () => {
    const database = new FakeReportDatabase();
    database.failNext = /^PRAGMA user_version$/;
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = await render(React.createElement(
      DataProvider,
      {
        createRepository: () => new ReportRepository({
          openDatabase: async () => database,
          tempFiles: { cleanupAbandonedDetailed: async () => DETAILED_CLEAN },
        }),
        lifecycleCoordinator,
      },
      React.createElement(Probe),
    ));

    await waitFor(() => expect(view.getByTestId('status').props.children).toBe('blocked'));
    expect(view.getByTestId('repository').props.children).toBe('hidden');
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    await view.unmount();
  });
});
