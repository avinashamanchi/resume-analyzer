import { act, render, waitFor } from '@testing-library/react-native';
import React, { StrictMode } from 'react';
import { Text } from 'react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import { DataProvider, useReportData } from '../src/storage/DataProvider';
import { ReportRepository } from '../src/storage/reportRepository';

import { FakeReportDatabase } from '../test-utils/fakeReportDatabase';

const CLEAN = { attempted: 0, deleted: 0, failed: 0, refused: 0 } as const;

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
  it('persists only the allowlisted report projection', async () => {
    const database = new FakeReportDatabase();
    const repository = new ReportRepository({
      openDatabase: async () => database,
      tempFiles: { cleanupAbandoned: async () => CLEAN },
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
      tempFiles: { cleanupAbandoned: async () => { throw new Error(privateCause); } },
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
      tempFiles: { cleanupAbandoned: async () => CLEAN },
    });
    const view = await render(React.createElement(
      DataProvider,
      { createRepository: () => repository },
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
        { createRepository: () => {
          const database = new FakeReportDatabase();
          const repository = new ReportRepository({
            openDatabase: async () => database,
            tempFiles: { cleanupAbandoned: async () => CLEAN },
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

  it('blocks on initialization failure without surfacing raw errors', async () => {
    const database = new FakeReportDatabase();
    database.failNext = /^PRAGMA user_version$/;
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = await render(React.createElement(
      DataProvider,
      {
        createRepository: () => new ReportRepository({
          openDatabase: async () => database,
          tempFiles: { cleanupAbandoned: async () => CLEAN },
        }),
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
