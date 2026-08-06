import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo } from 'react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import { ResultsScreen } from '../app/results/[analysisId]';
import { AppControllerProvider } from '../src/controllers/AppController';
import type { ExportReceipt, ReportExporterPort } from '../src/export/reportExporter';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ analysisId: '8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b' }),
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
      share: jest.fn(async () => undefined),
    } satisfies ReportExporterPort,
  };
}

describe('Results accessibility gates', () => {
  afterEach(() => { jest.restoreAllMocks(); });

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
    expect(scroll.props.contentContainerStyle).toEqual(expect.objectContaining({ flexGrow: 1 }));
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

    await waitFor(() => expect(pdf.value.share).toHaveBeenCalledWith(pdf.receipt));
    expect(pdf.value.export).toHaveBeenCalledWith(report);
    const status = view.getByRole('alert');
    expect(status.props.children).toBe('Share sheet closed. The temporary PDF was removed.');
    expect(status.props.accessibilityLiveRegion).toBe('polite');
    expect(announce).toHaveBeenCalledWith('Share sheet closed. The temporary PDF was removed.');
    expect(JSON.stringify(announce.mock.calls)).not.toMatch(/file:|\/Print\//i);
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
