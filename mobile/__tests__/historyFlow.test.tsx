import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo } from 'react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import HistoryScreen from '../app/(tabs)/history';
import { AppControllerProvider } from '../src/controllers/AppController';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const actions = {
  pickPdfForDisplay: jest.fn(), resetConsent: jest.fn(), cleanupCache: jest.fn(),
  shareSummary: jest.fn(), openSupport: jest.fn(),
  serviceAvailable: true, appVersion: '1.0.0',
};
const analysis = { state: { result: null }, commands: {} } as any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('native History flow', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('directs a person from an empty local history back to Analyze', async () => {
    const history = { status: 'ready', reports: [], error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(), delete: jest.fn(), deleteAll: jest.fn() } as any;
    const view = await render(<AppControllerProvider value={{ actions, analysis, history }}><HistoryScreen /></AppControllerProvider>);
    expect(view.getByText('No saved reports')).toBeTruthy();
    expect(view.getByText(/Reports appear here only after/i)).toBeTruthy();
  });

  it('renders allowlisted report fields and requires delete confirmation', async () => {
    const report = { ...validFixture, id: validFixture.analysisId, title: 'Resume analysis — 2026-08-05', createdAt: '2026-08-05T19:20:30.000Z' };
    const history = { status: 'ready', reports: [report], error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(), delete: jest.fn(async () => true), deleteAll: jest.fn() } as any;
    const view = await render(<AppControllerProvider value={{ actions, analysis, history }}><HistoryScreen /></AppControllerProvider>);
    expect(view.getByText(report.title)).toBeTruthy();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: `Delete ${report.title}` })); });
    const modal = view.getByTestId('delete-report-modal');
    expect(modal.props.accessibilityViewIsModal).toBe(true);
    expect(history.delete).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete report' })); });
    expect(history.delete).toHaveBeenCalledWith(report.id);
  });

  it('keeps separate VoiceOver actions reachable and recovers after a failed deletion in a long list', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    const reports = Array.from({ length: 20 }, (_, index) => ({
      ...validFixture,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `Resume analysis ${index + 1}`,
      createdAt: `2026-08-${String((index % 5) + 1).padStart(2, '0')}T19:20:30.000Z`,
    }));
    const history = {
      status: 'ready', reports, error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(),
      delete: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      deleteAll: jest.fn(),
    } as any;
    const view = await render(<AppControllerProvider value={{ actions, analysis, history }}><HistoryScreen /></AppControllerProvider>);

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete Resume analysis 10' })); });
    const modal = view.getByTestId('delete-report-modal');
    expect(modal.props.accessibilityViewIsModal).toBe(true);
    expect(view.getByRole('button', { name: 'Keep report' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Delete report' })).toBeTruthy();

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete report' })); });
    await waitFor(() => expect(view.getByRole('alert').props.children).toBe('The local report was not deleted. Try again.'));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('The local report was not deleted. Try again.');
    expect(view.getByTestId('delete-report-modal')).toBeTruthy();
    expect(view.getByText('Resume analysis 10')).toBeTruthy();

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete report' })); });
    await waitFor(() => expect(view.queryByTestId('delete-report-modal')).toBeNull());
    expect(history.delete).toHaveBeenNthCalledWith(1, reports[9].id);
    expect(history.delete).toHaveBeenNthCalledWith(2, reports[9].id);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('uses a virtualized page and exposes bounded older/newest navigation', async () => {
    const report = {
      ...validFixture,
      id: validFixture.analysisId,
      title: 'Resume analysis',
      createdAt: '2026-08-05T19:20:30.000Z',
    };
    const history = {
      status: 'ready',
      reports: [report],
      reportCount: 100,
      hasMore: true,
      hasNewer: true,
      loadingMore: false,
      error: null,
      load: jest.fn(),
      loadMore: jest.fn(async () => undefined),
      returnToNewest: jest.fn(async () => undefined),
      get: jest.fn(),
      saveCurrent: jest.fn(),
      delete: jest.fn(),
      deleteAll: jest.fn(),
    } as any;
    const view = render(
      <AppControllerProvider value={{ actions, analysis, history }}>
        <HistoryScreen />
      </AppControllerProvider>,
    );

    const list = view.getByTestId('report-list');
    expect(list.props.data).toHaveLength(1);
    expect(list.props.windowSize).toBe(7);
    await act(async () => { fireEvent(list, 'endReached'); });
    expect(history.loadMore).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Return to newest reports' }));
    });
    expect(history.returnToNewest).toHaveBeenCalledTimes(1);
  });

  it('announces one safe failure when deletion rejects and keeps the modal recoverable', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    const privateCause = new Error('sqlite path /private/resume-ai.db');
    const report = { ...validFixture, id: validFixture.analysisId, title: 'Resume analysis', createdAt: '2026-08-05T19:20:30.000Z' };
    const history = {
      status: 'ready', reports: [report], error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(),
      delete: jest.fn().mockRejectedValueOnce(privateCause), deleteAll: jest.fn(),
    } as any;
    const view = await render(<AppControllerProvider value={{ actions, analysis, history }}><HistoryScreen /></AppControllerProvider>);

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete Resume analysis' })); });
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete report' })); });

    await waitFor(() => expect(view.getByText('The local report was not deleted. Try again.')).toBeTruthy());
    expect(view.getByTestId('delete-report-modal')).toBeTruthy();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('The local report was not deleted. Try again.');
    expect(JSON.stringify(announce.mock.calls)).not.toContain(privateCause.message);
  });

  it('does not announce or move accessibility focus after an in-flight deletion unmounts', async () => {
    const pendingDelete = deferred<boolean>();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus');
    announce.mockClear();
    focus.mockClear();
    const report = { ...validFixture, id: validFixture.analysisId, title: 'Resume analysis', createdAt: '2026-08-05T19:20:30.000Z' };
    const history = {
      status: 'ready', reports: [report], error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(),
      delete: jest.fn(() => pendingDelete.promise), deleteAll: jest.fn(),
    } as any;
    const view = await render(<AppControllerProvider value={{ actions, analysis, history }}><HistoryScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete Resume analysis' })); });
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete report' })); });

    await view.unmount();
    await act(async () => { pendingDelete.resolve(false); await pendingDelete.promise; });

    expect(announce).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
