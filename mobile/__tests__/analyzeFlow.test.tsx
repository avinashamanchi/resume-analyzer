import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Keyboard, StyleSheet } from 'react-native';

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as { readFileSync(path: string, encoding: string): string };
const { resolve } = require('path') as { resolve(...parts: string[]): string };

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import AnalyzeScreen from '../app/(tabs)/index';
import ResultsScreen from '../app/results/[analysisId]';
import { AppControllerProvider } from '../src/controllers/AppController';
import { createRuntimeComposition } from '../src/controllers/runtime';
import type { AnalysisState } from '../src/analysis/analysisReducer';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ analysisId: '8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b' }),
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn() }),
}));

const readyState: AnalysisState = {
  status: 'ready',
  privacyReadiness: 'ready',
  source: null,
  jobDescription: '',
  result: null,
  error: null,
  generation: 1,
  activation: null,
  cleanupPending: false,
  mutation: 'none',
};

function pdfSource(identity: symbol, requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
  return {
    kind: 'pdf' as const,
    requestId,
    uri: `file:///app/cache/resume-ai-v1/${requestId}/11111111-1111-4111-8111-111111111111.pdf`,
    size: 100,
    lease: identity,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Record<string, unknown> = {}): any {
  const analysis = {
    state: readyState,
    commands: {
      selectSource: jest.fn(async () => ({ committed: true, sourceIdentity: null, generation: 2 })),
      setJobDescription: jest.fn(async () => ({ committed: true, generation: 3 })),
      analyze: jest.fn(async () => undefined),
      grantConsent: jest.fn(async () => undefined),
      declineConsent: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      reset: jest.fn(async () => undefined),
    },
  };
  const actions = {
    pickPdfForDisplay: jest.fn(async () => null),
    resetConsent: jest.fn(async () => undefined),
    cleanupCache: jest.fn(async () => ({ verified: true, deletedFiles: 0 })),
    shareSummary: jest.fn(async () => undefined),
    openSupport: jest.fn(async () => undefined),
    serviceAvailable: true,
    appVersion: '1.0.0',
  };
  const history = {
    status: 'ready' as const,
    reports: [],
    error: null,
    load: jest.fn(async () => undefined),
    saveCurrent: jest.fn(async () => null),
    get: jest.fn(async () => validFixture),
    delete: jest.fn(async () => true),
    deleteAll: jest.fn(async () => ({ deletedReports: 0, deletedTempFiles: 0, failures: 0 })),
  };
  return { analysis, actions, history, ...overrides };
}

describe('native Analyze and Results flows', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('shows consent before analysis and never claims fake phases', async () => {
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, status: 'consentRequired' } },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);

    const dialog = view.getByTestId('consent-dialog');
    expect(dialog.props.accessibilityRole).toBe('dialog');
    expect(dialog.props.accessibilityViewIsModal).toBe(true);
    expect(view.getByText(/The selected PDF is uploaded and processed before temporary cleanup runs/i)).toBeTruthy();
    expect(view.getByText(/does not show the analysis as successful and blocks future analysis/i)).toBeTruthy();
    expect(view.getByText(/Cleanup cannot undo processing already completed by the Resume\.AI server or Groq/i)).toBeTruthy();
    expect(view.queryByText(/cleanup.*blocks processing if it cannot complete/i)).toBeNull();
    expect(view.queryByText(/writing power bullets|optimizing|percent/i)).toBeNull();
  });

  it('keeps consent copy scrollable and its two actions reachable at large text', async () => {
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, status: 'consentRequired' } },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);

    const copyStyle = StyleSheet.flatten(view.getByTestId('consent-scroll').props.contentContainerStyle);
    const actionsStyle = StyleSheet.flatten(view.getByTestId('consent-actions').props.style);
    expect(copyStyle.flexGrow).toBe(1);
    expect(actionsStyle.flexShrink).toBe(0);
    expect(view.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Agree and analyze' })).toBeTruthy();
  });

  it('grants or declines consent only from explicit sheet actions', async () => {
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, status: 'consentRequired' } },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Agree and analyze' })); });
    expect(values.analysis.commands.grantConsent).toHaveBeenCalledTimes(1);
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Not now' })); });
    expect(values.analysis.commands.declineConsent).toHaveBeenCalledTimes(1);
  });

  it('shows a PDF filename only from an authoritative committed-source identity', async () => {
    const identity = Symbol('pdf-a');
    const source = pdfSource(identity);
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, source } },
    });
    values.actions.pickPdfForDisplay.mockResolvedValueOnce({ sourceIdentity: identity, sourceGeneration: 1, displayName: 'My Resume.pdf' });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);

    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(view.getByText('My Resume.pdf')).toBeTruthy());
    expect(values.analysis.commands.selectSource).not.toHaveBeenCalled();
  });

  it.each([
    ['consent decline with job text', { status: 'idle', jobDescription: 'private target role' }],
    ['analysis cancellation', { status: 'cancelled', jobDescription: '' }],
  ] as const)('clears the committed PDF display after %s consumes its source', async (_label, terminal) => {
    const identity = Symbol('pdf-a');
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, source: pdfSource(identity) } },
    });
    values.actions.pickPdfForDisplay.mockResolvedValueOnce({ sourceIdentity: identity, sourceGeneration: 1, displayName: 'Private A.pdf' });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(view.getByText('Private A.pdf')).toBeTruthy());

    await view.rerender(
      <AppControllerProvider value={{
        ...values,
        analysis: {
          ...values.analysis,
          state: {
            ...readyState,
            ...terminal,
            source: null,
            generation: 2,
          },
        },
      }}><AnalyzeScreen /></AppControllerProvider>,
    );

    await waitFor(() => expect(view.queryByText('Private A.pdf')).toBeNull());
  });

  it('keeps the current display after a rejected replacement', async () => {
    const identityA = Symbol('pdf-a');
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, source: pdfSource(identityA) } },
    });
    values.actions.pickPdfForDisplay.mockResolvedValueOnce({ sourceIdentity: identityA, sourceGeneration: 1, displayName: 'Private A.pdf' });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(view.getByText('Private A.pdf')).toBeTruthy());

    values.actions.pickPdfForDisplay.mockResolvedValueOnce(null);
    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    expect(view.queryByText('Rejected B.pdf')).toBeNull();
    expect(view.getByText('Private A.pdf')).toBeTruthy();
  });

  it('drops a stale display identity during a replacement race', async () => {
    const identityA = Symbol('pdf-a');
    const identityB = Symbol('pdf-b');
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, source: pdfSource(identityA) } },
    });
    values.actions.pickPdfForDisplay.mockResolvedValueOnce({ sourceIdentity: identityA, sourceGeneration: 1, displayName: 'Private A.pdf' });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(view.getByText('Private A.pdf')).toBeTruthy());

    await view.rerender(
      <AppControllerProvider value={{
        ...values,
        analysis: { ...values.analysis, state: { ...readyState, source: pdfSource(identityB, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), generation: 3 } },
      }}><AnalyzeScreen /></AppControllerProvider>,
    );
    await waitFor(() => expect(view.queryByText('Private A.pdf')).toBeNull());
  });

  it('renders one honest cancellable analyzing state', async () => {
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, status: 'analyzing' } },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    expect(view.getByText('Analyzing securely…')).toBeTruthy();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Cancel analysis' })); });
    expect(values.analysis.commands.cancel).toHaveBeenCalledTimes(1);
  });

  it('offers retry only for retryable failures with a source still available', async () => {
    const retryable = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          source: { kind: 'text', text: 'Resume text' },
          error: { category: 'network', message: 'The service could not be reached.', retryable: true },
        },
      },
    });
    const retryView = await render(<AppControllerProvider value={retryable}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(retryView.getByRole('button', { name: 'Try analysis again' })); });
    expect(retryable.analysis.commands.analyze).toHaveBeenCalledTimes(1);
    await retryView.unmount();

    const blocked = harness({
      analysis: {
        ...harness().analysis,
        state: { ...readyState, status: 'failed', source: null, error: { category: 'service', message: 'The service could not complete the request.', retryable: true } },
      },
    });
    const blockedView = await render(<AppControllerProvider value={blocked}><AnalyzeScreen /></AppControllerProvider>);
    expect(blockedView.queryByRole('button', { name: 'Try analysis again' })).toBeNull();
  });

  it('blocks analysis while private storage readiness is checking', async () => {
    const values = harness({ analysis: { ...harness().analysis, state: { ...readyState, privacyReadiness: 'checking', status: 'idle' } } });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    expect(view.getByText('Checking private temporary storage…')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Analyze resume' }).props.accessibilityState.disabled).toBe(true);
  });

  it('rejects pasted NUL input before selecting or uploading', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    const values = harness();
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
    await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'private\0resume'); });
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });
    expect(values.analysis.commands.selectSource).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(view.getByText('Check the resume and job-description limits before analyzing.')).toBeTruthy();
  });

  it('dismisses the focused keyboard after validation and immediately before requesting consent', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    dismiss.mockClear();
    const values = harness();
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
    await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'Validated resume text'); });
    await act(async () => { fireEvent.changeText(view.getByLabelText('Optional job description'), 'Validated role text'); });

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(values.analysis.commands.analyze).toHaveBeenCalledTimes(1);
    expect(dismiss.mock.invocationCallOrder[0]).toBeLessThan(values.analysis.commands.analyze.mock.invocationCallOrder[0]);
    expect(values.analysis.commands.setJobDescription.mock.invocationCallOrder[0]).toBeLessThan(dismiss.mock.invocationCallOrder[0]);
  });

  it('stops preparation when the pasted source is not authoritatively committed', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    dismiss.mockClear();
    const values = harness();
    values.analysis.commands.selectSource.mockResolvedValueOnce({ committed: false });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
    await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'Validated resume text'); });

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });

    await waitFor(() => expect(view.getByText('Check the resume and job-description limits before analyzing.')).toBeTruthy());
    expect(values.analysis.commands.setJobDescription).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
  });

  it('stops preparation when the job edit is not authoritatively committed', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    dismiss.mockClear();
    const values = harness();
    values.analysis.commands.setJobDescription.mockResolvedValueOnce({ committed: false });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
    await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'Validated resume text'); });

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });

    await waitFor(() => expect(view.getByText('Check the resume and job-description limits before analyzing.')).toBeTruthy());
    expect(dismiss).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
  });

  it('does not continue a deferred job preparation after the screen unmounts', async () => {
    const pendingJob = deferred<{ committed: true; generation: number }>();
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    dismiss.mockClear();
    const values = harness();
    values.analysis.commands.setJobDescription.mockReturnValueOnce(pendingJob.promise);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
    await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'Validated resume text'); });
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });
    await waitFor(() => expect(values.analysis.commands.setJobDescription).toHaveBeenCalledTimes(1));

    await view.unmount();
    await act(async () => {
      pendingJob.resolve({ committed: true, generation: 4 });
      await pendingJob.promise;
    });

    expect(dismiss).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
  });

  it.each(['source', 'job'] as const)('keeps a rejected %s preparation content-free and outside consent', async stage => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    dismiss.mockClear();
    const privateCause = new Error('file:///private/Secret Resume.pdf');
    const values = harness();
    if (stage === 'source') values.analysis.commands.selectSource.mockRejectedValueOnce(privateCause);
    else values.analysis.commands.setJobDescription.mockRejectedValueOnce(privateCause);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
    await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'Validated resume text'); });

    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });

    await waitFor(() => expect(view.getByText('Check the resume and job-description limits before analyzing.')).toBeTruthy());
    expect(JSON.stringify(view.toJSON())).not.toContain(privateCause.message);
    expect(view.queryByTestId('consent-dialog')).toBeNull();
    expect(dismiss).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
  });

  it('navigates only when the coordinator owns a succeeded result', async () => {
    mockReplace.mockClear();
    const values = harness({
      analysis: { ...harness().analysis, state: { ...readyState, status: 'succeeded', result: validFixture } },
    });
    await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/results/${validFixture.analysisId}`));
  });

  it('keeps screens behind controller hooks and composes providers at root', () => {
    const root = readFileSync(resolve(__dirname, '../app/_layout.tsx'), 'utf8');
    expect(root).toContain('<DataProvider');
    expect(root).toContain('<AnalysisProvider');
    expect(root).toContain('<AppControllerRoot');
    for (const path of ['../app/(tabs)/index.tsx', '../app/(tabs)/history.tsx', '../app/(tabs)/settings.tsx', '../app/results/[analysisId].tsx']) {
      const screen = readFileSync(resolve(__dirname, path), 'utf8');
      expect(screen).not.toMatch(/\b(fetch|ResumeApi|ReportRepository|SecureStore|SQLite|FileSystem)\b/);
    }
  });

  it('constructs missing and invalid API configuration without a startup request', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    expect(() => createRuntimeComposition('')).not.toThrow();
    expect(createRuntimeComposition('').services.serviceAvailable).toBe(false);
    expect(() => createRuntimeComposition('http://localhost:5000')).not.toThrow();
    expect(createRuntimeComposition('http://localhost:5000').services.serviceAvailable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('stacks bounded result sections and saves only on explicit action', async () => {
    const values = harness();
    const view = await render(<AppControllerProvider value={values}><ResultsScreen /></AppControllerProvider>);

    await waitFor(() => expect(view.getByLabelText('Resume readiness score')).toBeTruthy());
    const matched = view.getByText('Matched keywords');
    const missing = view.getByText('Missing keywords');
    expect(view.getByTestId('feedback-stack').props.style).toEqual(expect.objectContaining({ flexDirection: 'column' }));
    expect(matched).toBeTruthy();
    expect(missing).toBeTruthy();
    expect(values.history.saveCurrent).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Save locally' })); });
    await waitFor(() => expect(values.history.saveCurrent).toHaveBeenCalledTimes(1));
  });
});
