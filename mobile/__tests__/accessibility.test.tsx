import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  StyleSheet,
  type AppStateStatus,
} from 'react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import { ResultsScreen } from '../app/results/[analysisId]';
import { AppControllerProvider } from '../src/controllers/AppController';
import type { ExportReceipt, ReportExporterPort } from '../src/export/reportExporter';

const REPORT_A_ID = '8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b';
const REPORT_B_ID = '9ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b';
let mockAnalysisId = REPORT_A_ID;

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ analysisId: mockAnalysisId }),
  useRouter: () => ({ replace: jest.fn() }),
}));

const report = {
  id: validFixture.analysisId,
  title: 'Resume analysis',
  createdAt: '2026-08-05T19:20:30.000Z',
  sourceType: validFixture.sourceType,
  score: validFixture.score,
  feedback: validFixture.feedback,
};

const reportB = {
  ...report,
  id: REPORT_B_ID,
  title: 'Second resume analysis',
  feedback: {
    ...validFixture.feedback,
    summary: 'Second report summary.',
  },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function context(deleteResult = true) {
  return {
    actions: {
      pickPdfForDisplay: jest.fn(), resetConsent: jest.fn(), cleanupCache: jest.fn(),
      shareSummary: jest.fn(async () => undefined), openSupport: jest.fn(),
      serviceAvailable: true, appVersion: '1.0.0',
    },
    analysis: { state: { result: validFixture }, commands: { reset: jest.fn() } } as any,
    history: {
      status: 'ready', reports: [report], error: null, load: jest.fn(),
      get: jest.fn(async () => report), saveCurrent: jest.fn(),
      delete: jest.fn(async () => deleteResult), deleteAll: jest.fn(),
    } as any,
  };
}

function exporter() {
  const receipt: ExportReceipt = { numberOfPages: 2 };
  return {
    receipt,
    value: {
      cleanupAbandoned: jest.fn(async () => 0),
      export: jest.fn(async () => receipt),
      share: jest.fn(async (
        _receipt: ExportReceipt,
        _lifecycle: AbortSignal,
      ): Promise<void> => undefined),
      discard: jest.fn(async () => undefined),
    } satisfies ReportExporterPort,
  };
}

function pressHandler(view: Awaited<ReturnType<typeof render>>, label: string): () => void {
  const button = view.getByRole('button', { name: label });
  if (typeof button.props.onClick !== 'function') {
    throw new Error(`Missing press handler for ${label}.`);
  }
  const onClick = button.props.onClick;
  return () => onClick({
    currentTarget: button,
    target: button,
    nativeEvent: {},
    stopPropagation: jest.fn(),
  });
}

function retainedPressHandler(view: Awaited<ReturnType<typeof render>>, label: string): () => void {
  const button = view.getByRole('button', { name: label });
  const responder = button.props.onStartShouldSetResponder;
  const config = responder?.testOnly_pressabilityConfig?.();
  const onPress = config?.onPress;
  if (typeof onPress !== 'function') {
    throw new Error(`Missing retained press handler for ${label}.`);
  }
  return () => onPress({});
}

describe('Results accessibility gates', () => {
  afterEach(() => {
    mockAnalysisId = REPORT_A_ID;
    jest.restoreAllMocks();
  });

  it('gives report actions separate names, hints, roles, and 48-point targets', async () => {
    const app = context();
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByText('Your editorial read.')).toBeTruthy());

    const shareReport = view.getByRole('button', { name: 'Share report' });
    expect(shareReport).toHaveStyle({ minHeight: 48, minWidth: 48 });
    expect(shareReport.props.accessibilityHint).toMatch(/Creates a PDF report/i);
    expect(view.getByRole('button', { name: 'Share text summary' }).props.accessibilityHint)
      .toMatch(/text summary/i);
    expect(view.getByText(validFixture.score.label)).toBeTruthy();
    expect(view.getByLabelText('Resume readiness score')).toHaveTextContent(/85\/100/);
    const score = view.getByLabelText('Readiness score: 85 out of 100, Strong');
    expect(score.props.numberOfLines).toBeUndefined();
    expect(score.props.adjustsFontSizeToFit).not.toBe(true);
  });

  it('keeps the narrow large-text results layout scrollable, stacked, and keyboard safe', async () => {
    const app = context();
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByTestId('feedback-stack')).toBeTruthy());

    const scroll = view.getByTestId('screen-scroll-view');
    expect(scroll.props.keyboardDismissMode).toBe('interactive');
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle))
      .toEqual(expect.objectContaining({ flexGrow: 1 }));
    expect(view.getByTestId('feedback-stack')).toHaveStyle({ flexDirection: 'column' });
  });

  it('does not export until Share report is pressed and announces a path-free completion status', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    const app = context();
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByRole('button', { name: 'Share report' })).toBeTruthy());
    expect(pdf.value.export).not.toHaveBeenCalled();
    expect(pdf.value.share).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Share report' }));
    });

    await waitFor(() => expect(pdf.value.share).toHaveBeenCalledWith(
      pdf.receipt,
      expect.anything(),
    ));
    expect(pdf.value.export).toHaveBeenCalledWith(report);
    const status = view.getByRole('alert');
    expect(status.props.children).toBe('Share sheet closed. The temporary PDF was removed.');
    expect(status.props.accessibilityLiveRegion).toBe('polite');
    expect(announce).toHaveBeenCalledWith('Share sheet closed. The temporary PDF was removed.');
    expect(JSON.stringify(announce.mock.calls)).not.toMatch(/file:|\/Print\//i);
  });

  it('authorizes only one PDF share when two press callbacks arrive in the same render turn', async () => {
    const app = context();
    const pdf = exporter();
    const pendingExport = deferred<ExportReceipt>();
    pdf.value.export.mockImplementation(async () => pendingExport.promise);
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share report' }));
    const press = pressHandler(view, 'Share report');

    await act(async () => {
      press();
      press();
    });
    pendingExport.resolve(pdf.receipt);
    await waitFor(() => expect(pdf.value.share).toHaveBeenCalled());

    expect(pdf.value.export).toHaveBeenCalledTimes(1);
    expect(pdf.value.share).toHaveBeenCalledTimes(1);
  });

  it('aborts a PDF at the native-share boundary when routing to another report', async () => {
    const app = context();
    app.history.get.mockImplementation(async (analysisId: string) => (
      analysisId === REPORT_A_ID ? report : reportB
    ));
    const pdf = exporter();
    const pendingShare = deferred<void>();
    pdf.value.share.mockImplementation(async () => pendingShare.promise);
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share report' }));
    fireEvent.press(view.getByRole('button', { name: 'Share report' }));
    await waitFor(() => expect(pdf.value.share).toHaveBeenCalledTimes(1));
    const lifecycle = pdf.value.share.mock.calls[0][1];
    expect(lifecycle.aborted).toBe(false);

    mockAnalysisId = REPORT_B_ID;
    await view.rerender(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );

    expect(lifecycle.aborted).toBe(true);
    await act(async () => {
      pendingShare.resolve();
      await pendingShare.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole('button', { name: 'Share report' })).toBeEnabled());
    view.unmount();
  });

  it('aborts a PDF at the native-share boundary when the screen unmounts', async () => {
    const app = context();
    const pdf = exporter();
    const pendingShare = deferred<void>();
    pdf.value.share.mockImplementation(async () => pendingShare.promise);
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share report' }));
    fireEvent.press(view.getByRole('button', { name: 'Share report' }));
    await waitFor(() => expect(pdf.value.share).toHaveBeenCalledTimes(1));
    const lifecycle = pdf.value.share.mock.calls[0][1];

    await view.unmount();

    expect(lifecycle.aborted).toBe(true);
    await act(async () => {
      pendingShare.resolve();
      await pendingShare.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it.each<AppStateStatus>(['inactive', 'background'])(
    'aborts a PDF at the native-share boundary when AppState becomes %s',
    async (nextState) => {
      let onAppStateChange: ((state: AppStateStatus) => void) | undefined;
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
        onAppStateChange = listener;
        return { remove: jest.fn() };
      });
      const app = context();
      const pdf = exporter();
      const pendingShare = deferred<void>();
      pdf.value.share.mockImplementation(async () => pendingShare.promise);
      const view = await render(
        <AppControllerProvider value={app}>
          <ResultsScreen exporter={pdf.value} />
        </AppControllerProvider>,
      );
      await waitFor(() => view.getByRole('button', { name: 'Share report' }));
      fireEvent.press(view.getByRole('button', { name: 'Share report' }));
      await waitFor(() => expect(pdf.value.share).toHaveBeenCalledTimes(1));
      const lifecycle = pdf.value.share.mock.calls[0][1];

      await act(async () => { onAppStateChange?.(nextState); });

      expect(lifecycle.aborted).toBe(true);
      await act(async () => {
        pendingShare.resolve();
        await pendingShare.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => expect(view.getByRole('button', { name: 'Share report' })).toBeEnabled());
      view.unmount();
    },
  );

  it('does not start PDF sharing while text sharing owns the native action boundary', async () => {
    const app = context();
    const pendingTextShare = deferred<undefined>();
    app.actions.shareSummary.mockImplementation(async () => pendingTextShare.promise);
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share text summary' }));
    const shareText = pressHandler(view, 'Share text summary');
    const sharePdf = pressHandler(view, 'Share report');

    await act(async () => {
      shareText();
      sharePdf();
    });
    pendingTextShare.resolve(undefined);
    await act(async () => { await pendingTextShare.promise; });

    expect(app.actions.shareSummary).toHaveBeenCalledTimes(1);
    expect(pdf.value.export).not.toHaveBeenCalled();
    expect(pdf.value.share).not.toHaveBeenCalled();
  });

  it('rejects a retained report-A text handler invoked after routing to report B', async () => {
    const app = context();
    app.history.get.mockImplementation(async (analysisId: string) => (
      analysisId === REPORT_A_ID ? report : reportB
    ));
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share text summary' }));
    const retainedTextShare = retainedPressHandler(view, 'Share text summary');

    mockAnalysisId = REPORT_B_ID;
    await view.rerender(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByText('Second report summary.')).toBeTruthy());
    await act(async () => {
      retainedTextShare();
      await Promise.resolve();
    });

    expect(app.actions.shareSummary).not.toHaveBeenCalled();
  });

  it('rejects a retained report-A PDF handler invoked after routing to report B', async () => {
    const app = context();
    app.history.get.mockImplementation(async (analysisId: string) => (
      analysisId === REPORT_A_ID ? report : reportB
    ));
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share report' }));
    const retainedPdfShare = retainedPressHandler(view, 'Share report');

    mockAnalysisId = REPORT_B_ID;
    await view.rerender(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByText('Second report summary.')).toBeTruthy());
    await act(async () => {
      retainedPdfShare();
      await Promise.resolve();
    });

    expect(pdf.value.export).not.toHaveBeenCalled();
    expect(pdf.value.share).not.toHaveBeenCalled();
    expect(pdf.value.discard).not.toHaveBeenCalled();
  });

  it('rejects a retained text handler invoked after unmount', async () => {
    const app = context();
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share text summary' }));
    const retainedTextShare = retainedPressHandler(view, 'Share text summary');

    await view.unmount();
    await act(async () => {
      retainedTextShare();
      await Promise.resolve();
    });

    expect(app.actions.shareSummary).not.toHaveBeenCalled();
  });

  it('rejects a retained PDF handler invoked after unmount', async () => {
    const app = context();
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Share report' }));
    const retainedPdfShare = retainedPressHandler(view, 'Share report');

    await view.unmount();
    await act(async () => {
      retainedPdfShare();
      await Promise.resolve();
    });

    expect(pdf.value.export).not.toHaveBeenCalled();
    expect(pdf.value.share).not.toHaveBeenCalled();
    expect(pdf.value.discard).not.toHaveBeenCalled();
  });

  it('hides the prior report and discards its late PDF when the route changes', async () => {
    const app = context();
    const pendingReport = deferred<typeof reportB>();
    app.history.get.mockImplementation(async (analysisId: string) => (
      analysisId === REPORT_A_ID ? report : pendingReport.promise
    ));
    const pdf = exporter();
    const pendingExport = deferred<ExportReceipt>();
    pdf.value.export.mockImplementation(async () => pendingExport.promise);
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByRole('button', { name: 'Share report' })).toBeTruthy());
    fireEvent.press(view.getByRole('button', { name: 'Share report' }));
    await waitFor(() => expect(pdf.value.export).toHaveBeenCalledTimes(1));

    mockAnalysisId = REPORT_B_ID;
    await view.rerender(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    const showedOpeningState = view.queryByText('Opening report…') !== null;
    const exposedStaleShare = view.queryByRole('button', { name: 'Share report' }) !== null;

    pendingReport.resolve(reportB);
    pendingExport.resolve(pdf.receipt);
    await waitFor(() => expect(view.getByText('Second report summary.')).toBeTruthy());
    await waitFor(() => expect(pdf.value.discard).toHaveBeenCalledWith(pdf.receipt));

    expect(showedOpeningState).toBe(true);
    expect(exposedStaleShare).toBe(false);
    expect(pdf.value.share).not.toHaveBeenCalled();
  });

  it('discards a late PDF without sharing after the results screen unmounts', async () => {
    const app = context();
    const pdf = exporter();
    const pendingExport = deferred<ExportReceipt>();
    pdf.value.export.mockImplementation(async () => pendingExport.promise);
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByRole('button', { name: 'Share report' })).toBeTruthy());
    fireEvent.press(view.getByRole('button', { name: 'Share report' }));
    await waitFor(() => expect(pdf.value.export).toHaveBeenCalledTimes(1));

    await view.unmount();
    pendingExport.resolve(pdf.receipt);
    await waitFor(() => expect(pdf.value.discard).toHaveBeenCalledWith(pdf.receipt));

    expect(pdf.value.share).not.toHaveBeenCalled();
  });

  it('single-flights same-render delete callbacks with one pending and one result announcement', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const pendingDelete = deferred<boolean>();
    const app = context();
    app.history.delete.mockImplementation(async () => pendingDelete.promise);
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Delete saved report' }));
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Delete saved report' }));
    });
    await waitFor(() => view.getByRole('button', { name: 'Confirm delete report' }));
    expect(view.getByText(/Restoring an existing backup may restore reports deleted from the active app/i)).toBeTruthy();
    const confirmDelete = pressHandler(view, 'Confirm delete report');
    announce.mockClear();

    await act(async () => {
      confirmDelete();
      confirmDelete();
    });

    expect(app.history.delete).toHaveBeenCalledTimes(1);
    expect(view.getByText('Deleting local report…')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Confirm delete report' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Keep report' })).toBeDisabled();
    await waitFor(() => expect(announce.mock.calls.filter(([message]) =>
      message === 'Deleting local report…')).toHaveLength(1));

    await act(async () => {
      pendingDelete.resolve(true);
      await pendingDelete.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole('alert').props.children).toBe('Local report deleted.'));
    expect(announce.mock.calls.filter(([message]) => message === 'Local report deleted.'))
      .toHaveLength(1);
  });

  it('does not let an old-route delete finally clear a newer delete authority', async () => {
    const firstDelete = deferred<boolean>();
    const secondDelete = deferred<boolean>();
    const app = context();
    app.history.reports = [report, reportB];
    app.history.get.mockImplementation(async (analysisId: string) => (
      analysisId === REPORT_A_ID ? report : reportB
    ));
    app.history.delete.mockImplementation(async (analysisId: string) => (
      analysisId === REPORT_A_ID ? firstDelete.promise : secondDelete.promise
    ));
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => view.getByRole('button', { name: 'Delete saved report' }));
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Delete saved report' }));
    });
    await waitFor(() => view.getByRole('button', { name: 'Confirm delete report' }));
    fireEvent.press(view.getByRole('button', { name: 'Confirm delete report' }));
    await waitFor(() => expect(app.history.delete).toHaveBeenCalledWith(REPORT_A_ID));

    mockAnalysisId = REPORT_B_ID;
    await view.rerender(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByText('Second report summary.')).toBeTruthy());
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Delete saved report' }));
    });
    await waitFor(() => view.getByRole('button', { name: 'Confirm delete report' }));
    fireEvent.press(view.getByRole('button', { name: 'Confirm delete report' }));
    await waitFor(() => expect(app.history.delete).toHaveBeenCalledWith(REPORT_B_ID));

    await act(async () => {
      firstDelete.resolve(true);
      await firstDelete.promise;
      await Promise.resolve();
    });

    expect(view.getByText('Deleting local report…')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Confirm delete report' })).toBeDisabled();
    expect(app.history.delete).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondDelete.resolve(true);
      await secondDelete.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole('alert').props.children).toBe('Local report deleted.'));
  });

  it('keeps delete failure recoverable and announces a stable non-color error', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    const app = context(false);
    const pdf = exporter();
    const view = await render(
      <AppControllerProvider value={app}>
        <ResultsScreen exporter={pdf.value} />
      </AppControllerProvider>,
    );
    await waitFor(() => expect(view.getByRole('button', { name: 'Delete saved report' })).toBeTruthy());

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete saved report' })); });
    expect(view.getByRole('button', { name: 'Keep report' }).props.accessibilityHint)
      .toMatch(/Returns to the report/i);
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Confirm delete report' })); });

    await waitFor(() => expect(view.getByRole('alert').props.children)
      .toBe('The local report was not deleted. Try again.'));
    expect(view.getByTestId('delete-result-error').props.accessibilityLiveRegion).toBe('assertive');
    expect(view.getByRole('button', { name: 'Confirm delete report' })).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('The local report was not deleted. Try again.');

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Confirm delete report' })); });
    await waitFor(() => expect(app.history.delete).toHaveBeenCalledTimes(2));
    expect(announce.mock.calls.filter(([message]) =>
      message === 'The local report was not deleted. Try again.')).toHaveLength(2);
  });
});
