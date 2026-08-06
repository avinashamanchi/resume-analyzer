import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, Keyboard, StyleSheet } from 'react-native';

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
let mockRouteBlur: (() => void) | null = null;
jest.mock('expo-router', () => {
  const React = require('react') as typeof import('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = effect();
        mockRouteBlur = typeof cleanup === 'function' ? cleanup : null;
        return () => {
          if (mockRouteBlur === cleanup) mockRouteBlur = null;
          if (typeof cleanup === 'function') cleanup();
        };
      }, [effect]);
    },
    useLocalSearchParams: () => ({ analysisId: '8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b' }),
    useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn() }),
  };
});

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
  privacyRecoveryAvailable: false,
  mutation: 'none',
  lifecycleEpoch: 0,
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
      isVisionAvailable: jest.fn(() => false),
      extractVisionDraft: jest.fn(async () => ({ completed: false })),
      completeVisionReview: jest.fn(async () => ({
        committed: true,
        sourceIdentity: null,
        generation: 2,
      })),
      cancelVisionExtraction: jest.fn(async () => undefined),
      analyze: jest.fn(async () => undefined),
      grantConsent: jest.fn(async () => undefined),
      declineConsent: jest.fn(async () => undefined),
      cancel: jest.fn(async () => undefined),
      reset: jest.fn(async () => undefined),
      recoverPrivacyCleanup: jest.fn(async () => true),
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
    expect(view.getByText(/Computer backups are not encrypted by default.*Encrypt local backup/i)).toBeTruthy();
    expect(view.getByText(/Restoring an existing backup may restore reports deleted from the active app/i)).toBeTruthy();
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

  it('truthfully routes scan-required PDFs to paste text in Expo Go', async () => {
    const values = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          source: null,
          error: {
            category: 'service',
            code: 'scan_required',
            message: 'The service could not complete the request.',
            retryable: false,
          },
        },
      },
    });
    values.analysis.commands.isVisionAvailable.mockReturnValue(false);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);

    expect(view.queryByRole('button', { name: 'Extract on this iPhone' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Analyze resume' })).toBeNull();
    expect(view.getByText(/isn't available in Expo Go/i)).toBeTruthy();
    expect(view.getByText(/requires a Resume\.AI development build/i)).toBeTruthy();

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Paste resume text instead' }));
    });

    expect(values.analysis.commands.reset).toHaveBeenCalledTimes(1);
    expect(values.analysis.commands.extractVisionDraft).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
    expect(view.getByLabelText('Paste resume text')).toBeTruthy();
    await view.unmount();
  });

  it('requires editable explicit OCR review and never submits from extraction or Review complete', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const source = pdfSource(Symbol('scan-pdf'));
    const values = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          source,
          error: {
            category: 'service',
            code: 'scan_required',
            message: 'The service could not complete the request.',
            retryable: false,
          },
        },
      },
    });
    values.analysis.commands.isVisionAvailable.mockReturnValue(true);
    values.analysis.commands.extractVisionDraft.mockResolvedValueOnce({
      completed: true,
      generation: 1,
      authority: Symbol('review-authority'),
      draft: {
        kind: 'vision_text',
        text: 'Unreviewed OCR draft',
        reviewed: false,
        pageCount: 2,
      },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);

    const extract = view.getByRole('button', { name: 'Extract on this iPhone' });
    expect(extract.props.accessibilityHint).toMatch(/on-device text recognition/i);
    await act(async () => { fireEvent.press(extract); });

    const editor = await view.findByLabelText('Review extracted resume text');
    expect(editor.props.accessibilityHint).toMatch(/Edit recognition mistakes/i);
    expect(editor.props.multiline).toBe(true);
    expect(view.getByText('20 / 30,000')).toBeTruthy();
    expect(view.getByTestId('vision-review-status').props.accessibilityLiveRegion).toBe('polite');
    expect(announce).toHaveBeenCalledWith('OCR draft ready. Review and edit the extracted text.');
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
    expect(values.analysis.commands.completeVisionReview).not.toHaveBeenCalled();
    expect(values.analysis.commands.selectSource).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.changeText(editor, 'Corrected OCR resume text');
    });
    expect(view.getByDisplayValue('Corrected OCR resume text')).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Review complete' }));
    });

    expect(values.analysis.commands.completeVisionReview).toHaveBeenCalledWith(
      expect.any(Symbol),
      'Corrected OCR resume text',
    );
    expect(values.analysis.commands.selectSource).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
    expect(view.getByText('Reviewed scan ready')).toBeTruthy();
    await view.unmount();
  });

  it('cancels OCR review explicitly and clears its in-memory text', async () => {
    const values = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          source: pdfSource(Symbol('scan-pdf')),
          error: {
            category: 'service',
            code: 'scan_required',
            message: 'The service could not complete the request.',
            retryable: false,
          },
        },
      },
    });
    values.analysis.commands.isVisionAvailable.mockReturnValue(true);
    values.analysis.commands.extractVisionDraft.mockResolvedValueOnce({
      completed: true,
      generation: 1,
      authority: Symbol('review-authority'),
      draft: { kind: 'vision_text', text: 'private OCR text', reviewed: false, pageCount: 1 },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Extract on this iPhone' }));
    });

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Cancel OCR review' }));
    });

    expect(values.analysis.commands.reset).toHaveBeenCalledTimes(1);
    expect(view.queryByDisplayValue('private OCR text')).toBeNull();
    expect(values.analysis.commands.selectSource).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('revokes pending OCR on unmount and ignores its late private draft', async () => {
    const pending = deferred<{
      completed: true;
      generation: number;
      draft: { kind: 'vision_text'; text: string; reviewed: false; pageCount: number };
    }>();
    const values = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          source: pdfSource(Symbol('scan-pdf')),
          error: {
            category: 'service',
            code: 'scan_required',
            message: 'The service could not complete the request.',
            retryable: false,
          },
        },
      },
    });
    values.analysis.commands.isVisionAvailable.mockReturnValue(true);
    values.analysis.commands.extractVisionDraft.mockReturnValueOnce(pending.promise);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Extract on this iPhone' }));
    });
    await view.unmount();
    pending.resolve({
      completed: true,
      generation: 1,
      draft: { kind: 'vision_text', text: 'late private OCR', reviewed: false, pageCount: 1 },
    });
    await pending.promise;

    expect(values.analysis.commands.cancelVisionExtraction).toHaveBeenCalledTimes(1);
    expect(values.analysis.commands.selectSource).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
  });

  it('revokes pending OCR when the Analyze route loses focus without unmounting', async () => {
    const pending = deferred<{
      completed: true;
      generation: number;
      draft: { kind: 'vision_text'; text: string; reviewed: false; pageCount: number };
    }>();
    const values = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          source: pdfSource(Symbol('scan-pdf')),
          error: {
            category: 'service',
            code: 'scan_required',
            message: 'The service could not complete the request.',
            retryable: false,
          },
        },
      },
    });
    values.analysis.commands.isVisionAvailable.mockReturnValue(true);
    values.analysis.commands.extractVisionDraft.mockReturnValueOnce(pending.promise);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Extract on this iPhone' }));
    });

    await act(async () => { mockRouteBlur?.(); });
    pending.resolve({
      completed: true,
      generation: 1,
      draft: { kind: 'vision_text', text: 'late route draft', reviewed: false, pageCount: 1 },
    });
    await pending.promise;

    expect(values.analysis.commands.cancelVisionExtraction).toHaveBeenCalledTimes(1);
    expect(values.analysis.commands.selectSource).not.toHaveBeenCalled();
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
    await view.unmount();
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

  it('aborts the native picker authority when Analyze unmounts before selection resolves', async () => {
    const pending = deferred<null>();
    const values = harness();
    values.actions.pickPdfForDisplay.mockReturnValueOnce(pending.promise);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(values.actions.pickPdfForDisplay).toHaveBeenCalledTimes(1));
    const signal = values.actions.pickPdfForDisplay.mock.calls[0][0] as AbortSignal;

    await view.unmount();

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
    pending.resolve(null);
    await pending.promise;
  });

  it('aborts pending native picker authority from the provider lifecycle epoch', async () => {
    const pending = deferred<null>();
    const values = harness();
    values.actions.pickPdfForDisplay.mockReturnValueOnce(pending.promise);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(values.actions.pickPdfForDisplay).toHaveBeenCalledTimes(1));
    const signal = values.actions.pickPdfForDisplay.mock.calls[0][0] as AbortSignal;

    await view.rerender(
      <AppControllerProvider value={{
        ...values,
        analysis: {
          ...values.analysis,
          state: { ...readyState, status: 'idle', lifecycleEpoch: 1 },
        },
      }}><AnalyzeScreen /></AppControllerProvider>,
    );

    expect(signal.aborted).toBe(true);
    pending.resolve(null);
    await pending.promise;
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
  });

  it.each(['mode change', 'analyze intent'] as const)(
    '%s revokes a pending native picker rather than leaving hidden staged work',
    async intent => {
      const pending = deferred<null>();
      const values = harness();
      values.actions.pickPdfForDisplay.mockReturnValueOnce(pending.promise);
      const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
      await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
      await waitFor(() => expect(values.actions.pickPdfForDisplay).toHaveBeenCalledTimes(1));
      const signal = values.actions.pickPdfForDisplay.mock.calls[0][0] as AbortSignal;

      if (intent === 'mode change') {
        await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
        await waitFor(() => expect(values.analysis.commands.reset).toHaveBeenCalledTimes(1));
      } else {
        await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });
        await waitFor(() => expect(view.getByText('Check the resume and job-description limits before analyzing.')).toBeTruthy());
      }

      expect(signal.aborted).toBe(true);
      pending.resolve(null);
      await pending.promise;
      expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
    },
  );

  it('a replacement native pick aborts the older UI authority and remains current itself', async () => {
    const pendingA = deferred<null>();
    const pendingB = deferred<null>();
    const values = harness();
    values.actions.pickPdfForDisplay
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(values.actions.pickPdfForDisplay).toHaveBeenCalledTimes(1));
    const signalA = values.actions.pickPdfForDisplay.mock.calls[0][0] as AbortSignal;

    await act(async () => { fireEvent.press(view.getByLabelText('Choose resume PDF')); });
    await waitFor(() => expect(values.actions.pickPdfForDisplay).toHaveBeenCalledTimes(2));
    const signalB = values.actions.pickPdfForDisplay.mock.calls[1][0] as AbortSignal;

    expect(signalA.aborted).toBe(true);
    expect(signalB.aborted).toBe(false);
    await act(async () => {
      pendingA.resolve(null);
      pendingB.resolve(null);
      await Promise.all([pendingA.promise, pendingB.promise]);
      await Promise.resolve();
    });
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
    expect(view.getByLabelText('Choose resume PDF').props.accessibilityState.disabled).toBe(true);
    expect(view.getByRole('button', { name: 'Analyze resume' }).props.accessibilityState.disabled).toBe(true);
  });

  it('offers exact private-cleanup recovery without retrying analysis', async () => {
    const values = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          privacyReadiness: 'blocked',
          cleanupPending: true,
          privacyRecoveryAvailable: true,
          error: {
            category: 'privacy',
            message: 'Temporary resume data could not be removed safely.',
            retryable: false,
          },
        },
      },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Retry private cleanup' }));
    });

    expect(values.analysis.commands.recoverPrivacyCleanup).toHaveBeenCalledTimes(1);
    expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
  });

  it('does not offer exact-file recovery when a blocked state has no retained picker claim', async () => {
    const values = harness({
      analysis: {
        ...harness().analysis,
        state: {
          ...readyState,
          status: 'failed',
          privacyReadiness: 'blocked',
          cleanupPending: true,
          privacyRecoveryAvailable: false,
          error: {
            category: 'privacy',
            message: 'Temporary resume data could not be removed safely.',
            retryable: false,
          },
        },
      },
    });
    const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);

    expect(view.queryByRole('button', { name: 'Retry private cleanup' })).toBeNull();
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

  it.each(['background', 'inactive'] as const)(
    'does not continue a deferred source preparation after %s lifecycle invalidation',
    async _lifecycle => {
      const pendingSource = deferred<{ committed: true; sourceIdentity: null; generation: number }>();
      const dismiss = jest.spyOn(Keyboard, 'dismiss');
      dismiss.mockClear();
      const values = harness();
      values.analysis.commands.selectSource.mockReturnValueOnce(pendingSource.promise);
      const view = await render(<AppControllerProvider value={values}><AnalyzeScreen /></AppControllerProvider>);
      await act(async () => { fireEvent.press(view.getByRole('tab', { name: 'Paste text' })); });
      await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'Validated resume text'); });
      await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });
      await waitFor(() => expect(values.analysis.commands.selectSource).toHaveBeenCalledTimes(1));

      await view.rerender(
        <AppControllerProvider value={{
          ...values,
          analysis: {
            ...values.analysis,
            state: { ...readyState, status: 'idle', generation: 4, lifecycleEpoch: 1 },
          },
        }}><AnalyzeScreen /></AppControllerProvider>,
      );
      await act(async () => {
        pendingSource.resolve({ committed: true, sourceIdentity: null, generation: 3 });
        await pendingSource.promise;
      });

      expect(values.analysis.commands.setJobDescription).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(values.analysis.commands.analyze).not.toHaveBeenCalled();
      expect(view.queryByTestId('consent-dialog')).toBeNull();
    },
  );

  it.each(['background', 'inactive'] as const)(
    'invalidates a deferred job on %s and permits one newer foreground preparation',
    async _lifecycle => {
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

      const foregroundValues = {
        ...values,
        analysis: {
          ...values.analysis,
          state: { ...readyState, status: 'idle' as const, generation: 4, lifecycleEpoch: 1 },
        },
      };
      await view.rerender(<AppControllerProvider value={foregroundValues}><AnalyzeScreen /></AppControllerProvider>);
      await act(async () => {
        pendingJob.resolve({ committed: true, generation: 3 });
        await pendingJob.promise;
      });
      expect(dismiss).not.toHaveBeenCalled();
      expect(values.analysis.commands.analyze).not.toHaveBeenCalled();

      await act(async () => { fireEvent.changeText(view.getByLabelText('Paste resume text'), 'New foreground resume'); });
      await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Analyze resume' })); });
      await waitFor(() => expect(values.analysis.commands.analyze).toHaveBeenCalledTimes(1));
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(values.analysis.commands.setJobDescription).toHaveBeenCalledTimes(2);
    },
  );

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
