import validFixture from '../../contracts/fixtures/analysis-valid.json';

import {
  AnalysisCoordinator,
  type AnalysisCoordinatorOptions,
} from '../src/analysis/analysisCoordinator';
import {
  analysisReducer,
  createInitialAnalysisState,
} from '../src/analysis/analysisReducer';
import { CONSENT_VERSION } from '../src/domain/consent';
import type { AnalysisResponse } from '../src/domain/contracts';
import { ResumeApiError } from '../src/domain/errors';
import type { ResumeSource } from '../src/documents/documentSource';
import type { CleanupReceipt } from '../src/documents/tempFileRegistry';

const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESULT_A = '11111111-1111-4111-8111-111111111111';
const RESULT_B = '22222222-2222-4222-8222-222222222222';
const CLEAN: CleanupReceipt = { attempted: 0, deleted: 0, failed: 0, refused: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function result(analysisId = RESULT_A, sourceType: AnalysisResponse['sourceType'] = 'text') {
  return {
    ...validFixture,
    analysisId,
    sourceType,
  } as AnalysisResponse;
}

function textSource(text = 'private resume draft'): Extract<ResumeSource, { kind: 'text' }> {
  return { kind: 'text', text };
}

function pdfSource(requestId = REQUEST_A): Extract<ResumeSource, { kind: 'pdf' }> {
  return {
    kind: 'pdf',
    requestId,
    uri: `file:///app/cache/resume-ai-v1/${requestId}/11111111-1111-4111-8111-111111111111.pdf`,
    size: 1_024,
  };
}

function visionSource(reviewed: boolean): ResumeSource {
  return { kind: 'vision_text', text: 'Reviewed resume text', reviewed, pageCount: 2 };
}

function harness(overrides: Partial<AnalysisCoordinatorOptions> = {}) {
  let consent = true;
  const api = {
    analyze: jest.fn<Promise<AnalysisResponse>, [unknown, AbortSignal]>()
      .mockResolvedValue(result()),
  };
  const consentStore = {
    hasCurrentConsent: jest.fn(async () => consent),
    grant: jest.fn(async () => { consent = true; }),
  };
  const tempFiles = {
    cleanupAbandoned: jest.fn(async () => CLEAN),
    cleanupRequest: jest.fn(async () => CLEAN),
  };
  const coordinator = new AnalysisCoordinator({
    api,
    consentStore,
    tempFiles,
    cleanupTimeoutMs: 50,
    ...overrides,
  });
  return {
    api,
    consentStore,
    coordinator,
    setConsent(value: boolean) { consent = value; },
    tempFiles,
  };
}

async function readyHarness(overrides: Partial<AnalysisCoordinatorOptions> = {}) {
  const value = harness(overrides);
  await value.coordinator.initialize();
  await value.coordinator.commands.selectSource(textSource());
  return value;
}

describe('analysisReducer transition safety', () => {
  it('ignores a terminal event from an activation that is no longer current', () => {
    const source = textSource();
    let state = analysisReducer(createInitialAnalysisState(), {
      type: 'initializationReady',
    });
    state = analysisReducer(state, { type: 'sourceReady', generation: 1, source });
    state = analysisReducer(state, { type: 'analysisStarted', generation: 1, activation: 4 });

    expect(analysisReducer(state, {
      type: 'analysisSucceeded',
      generation: 1,
      activation: 3,
      result: result(RESULT_A),
      consumeSource: false,
    })).toBe(state);
  });

  it('rejects impossible success from a non-analyzing state', () => {
    const state = analysisReducer(createInitialAnalysisState(), {
      type: 'initializationReady',
    });
    expect(analysisReducer(state, {
      type: 'analysisSucceeded',
      generation: 0,
      activation: 1,
      result: result(),
      consumeSource: false,
    })).toBe(state);
  });
});

describe('analysis startup and consent barriers', () => {
  it('awaits abandoned cleanup before enabling source selection', async () => {
    const recovery = deferred<CleanupReceipt>();
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(() => recovery.promise),
        cleanupRequest: jest.fn(async () => CLEAN),
      },
    });

    const selection = coordinator.commands.selectSource(textSource());
    await flushPromises();
    expect(coordinator.getState()).toMatchObject({ privacyReadiness: 'checking', source: null });

    recovery.resolve({ attempted: 2, deleted: 2, failed: 0, refused: 0 });
    await selection;
    expect(coordinator.getState()).toMatchObject({ privacyReadiness: 'ready', status: 'ready' });
  });

  it.each([
    { attempted: 1, deleted: 0, failed: 1, refused: 0 },
    { attempted: 0, deleted: 0, failed: 0, refused: 1 },
    { attempted: 2, deleted: 1, failed: 0, refused: 0 },
  ])('fails closed for a refused or inconsistent recovery receipt %#p', async receipt => {
    const { api, coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => receipt),
        cleanupRequest: jest.fn(async () => CLEAN),
      },
    });

    await coordinator.initialize();
    await coordinator.commands.selectSource(textSource());
    await coordinator.commands.analyze();

    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'blocked',
      status: 'failed',
      error: { category: 'privacy', retryable: false },
    });
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('converts a rejected startup cleanup into a content-free privacy failure', async () => {
    const privateCause = 'file:///private/provider/actual-name.pdf';
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => { throw new Error(privateCause); }),
        cleanupRequest: jest.fn(async () => CLEAN),
      },
    });

    await coordinator.initialize();
    expect(JSON.stringify(coordinator.getState().error)).not.toContain(privateCause);
    expect(coordinator.getState()).toMatchObject({ privacyReadiness: 'blocked', status: 'failed' });
  });

  it('requires current consent before creating a request and decline keeps the draft', async () => {
    const { api, coordinator, setConsent } = await readyHarness();
    setConsent(false);

    await coordinator.commands.analyze();
    expect(coordinator.getState()).toMatchObject({ status: 'consentRequired', source: textSource() });
    expect(api.analyze).not.toHaveBeenCalled();

    await coordinator.commands.declineConsent();
    expect(coordinator.getState()).toMatchObject({ status: 'ready', source: textSource() });
  });

  it('treats Agree and analyze as one explicit action that persists only the versioned record', async () => {
    const { api, consentStore, coordinator, setConsent } = await readyHarness();
    setConsent(false);
    await coordinator.commands.analyze();

    await coordinator.commands.grantConsent();

    expect(consentStore.grant).toHaveBeenCalledTimes(1);
    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(api.analyze.mock.calls[0][0]).toMatchObject({ consentVersion: CONSENT_VERSION });
    expect(coordinator.getState().status).toBe('succeeded');
  });

  it.each(['read', 'write'] as const)('surfaces consent %s failure without uploading', async operation => {
    const { api, consentStore, coordinator, setConsent } = await readyHarness();
    const privateCause = new Error('private consent database row');
    if (operation === 'read') consentStore.hasCurrentConsent.mockRejectedValueOnce(privateCause);
    else {
      setConsent(false);
      consentStore.grant.mockRejectedValueOnce(privateCause);
      await coordinator.commands.analyze();
    }

    if (operation === 'read') await coordinator.commands.analyze();
    else await coordinator.commands.grantConsent();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      error: { category: 'consent_storage', retryable: false },
    });
    expect(JSON.stringify(coordinator.getState().error)).not.toContain(privateCause.message);
  });
});

describe('analysis generations and cancellation', () => {
  it('coalesces duplicate Analyze taps into the exact same in-flight promise', async () => {
    const pending = deferred<AnalysisResponse>();
    const { api, coordinator } = await readyHarness();
    api.analyze.mockReturnValueOnce(pending.promise);

    const first = coordinator.commands.analyze();
    const second = coordinator.commands.analyze();
    await flushPromises();

    expect(second).toBe(first);
    expect(api.analyze).toHaveBeenCalledTimes(1);
    pending.resolve(result());
    await first;
  });

  it('prevents an older never-settling request from overwriting a newer result', async () => {
    const first = deferred<AnalysisResponse>();
    const { api, coordinator } = await readyHarness();
    api.analyze.mockReturnValueOnce(first.promise).mockResolvedValueOnce(result(RESULT_B));

    void coordinator.commands.analyze();
    await flushPromises();
    await coordinator.commands.reset();
    await coordinator.commands.selectSource(textSource('new resume'));
    await coordinator.commands.analyze();
    first.resolve(result(RESULT_A));
    await flushPromises();

    expect(coordinator.getState().result?.analysisId).toBe(RESULT_B);
  });

  it('user cancellation promptly aborts a never-settling request without an automatic retry', async () => {
    const pending = deferred<AnalysisResponse>();
    const { api, coordinator } = await readyHarness();
    api.analyze.mockReturnValueOnce(pending.promise);
    const analysis = coordinator.commands.analyze();
    await flushPromises();

    await coordinator.commands.cancel();
    await analysis;

    expect(api.analyze.mock.calls[0][1].aborted).toBe(true);
    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toMatchObject({ status: 'cancelled', source: textSource() });
  });

  it('background aborts once and foreground does not replay private input', async () => {
    const pending = deferred<AnalysisResponse>();
    const { api, coordinator } = await readyHarness();
    api.analyze.mockReturnValueOnce(pending.promise);
    const analysis = coordinator.commands.analyze();
    await flushPromises();

    await coordinator.handleAppState('background');
    await analysis;
    await coordinator.handleAppState('active');

    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().status).toBe('cancelled');
  });

  it('source and job edits advance the opaque generation and reset clears memory', async () => {
    const { coordinator } = await readyHarness();
    const firstGeneration = coordinator.getState().generation;
    await coordinator.commands.setJobDescription('Private job description');
    expect(coordinator.getState().generation).toBeGreaterThan(firstGeneration);
    await coordinator.commands.selectSource(textSource('replacement'));
    expect(coordinator.getState()).toMatchObject({ source: textSource('replacement') });

    await coordinator.commands.reset();
    expect(coordinator.getState()).toMatchObject({
      status: 'idle',
      source: null,
      jobDescription: '',
      result: null,
      error: null,
    });
  });

  it.each([
    ['timeout', true],
    ['indeterminate', true],
    ['network', false],
    ['service', false],
    ['invalid_response', false],
    ['validation', false],
  ] as const)('does not automatically retry a %s API error', async (category, retryable) => {
    const { api, coordinator } = await readyHarness();
    api.analyze.mockRejectedValueOnce(new ResumeApiError(category, { retryable }));

    await coordinator.commands.analyze();
    await flushPromises();

    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      error: { category, retryable },
    });
  });

  it('rejects unreviewed Vision text and sends reviewed text without native PDF metadata', async () => {
    const { api, coordinator } = harness();
    await coordinator.initialize();
    await coordinator.commands.selectSource(visionSource(false));
    await coordinator.commands.analyze();
    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({ status: 'failed', error: { category: 'validation' } });

    await coordinator.commands.selectSource(visionSource(true));
    await coordinator.commands.analyze();
    expect(api.analyze.mock.calls[0][0]).toEqual({
      source: { kind: 'vision_text', text: 'Reviewed resume text' },
      jobDescription: undefined,
      consentVersion: CONSENT_VERSION,
    });
  });

  it('clears an older draft when an unreviewed Vision replacement is rejected', async () => {
    const { api, coordinator } = await readyHarness();

    await coordinator.commands.selectSource(visionSource(false));
    await coordinator.commands.analyze();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: null,
      error: { category: 'validation' },
    });
  });

  it('turns malformed runtime source input into a stable validation state', async () => {
    const { api, coordinator } = harness();
    await coordinator.initialize();

    await expect(coordinator.commands.selectSource({ kind: 'text', text: null } as never))
      .resolves.toBeUndefined();
    await coordinator.commands.analyze();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({ status: 'failed', source: null });
  });

  it('captures an immutable in-memory source revision instead of trusting later caller mutation', async () => {
    const { api, coordinator } = harness();
    await coordinator.initialize();
    const callerSource = { kind: 'text' as const, text: 'original private draft' };
    await coordinator.commands.selectSource(callerSource);

    callerSource.text = 'mutated after selection';
    await coordinator.commands.analyze();

    expect(api.analyze.mock.calls[0][0]).toMatchObject({
      source: { kind: 'text', text: 'original private draft' },
    });
    expect(coordinator.getState().source).toMatchObject({ text: 'original private draft' });
  });
});

describe('PDF terminal cleanup', () => {
  it('translates only the generated owned URI, actual size, fixed MIME, and generic filename', async () => {
    const { api, coordinator } = harness();
    await coordinator.initialize();
    await coordinator.commands.selectSource({
      ...pdfSource(),
      providerFilename: 'Private Person - Staff Resume.pdf',
    } as unknown as ResumeSource);
    await coordinator.commands.analyze();

    expect(api.analyze.mock.calls[0][0]).toMatchObject({
      source: {
        kind: 'pdf',
        uri: pdfSource().uri,
        size: 1_024,
        mimeType: 'application/pdf',
        name: 'resume.pdf',
      },
    });
    expect(JSON.stringify(coordinator.getState())).not.toContain('Private Person');
  });

  it.each([
    ['success', null],
    ['failure', new ResumeApiError('service')],
    ['timeout', new ResumeApiError('timeout', { retryable: true })],
  ] as const)('awaits verified cleanup before committing %s', async (_name, failure) => {
    const cleanup = deferred<CleanupReceipt>();
    const api = {
      analyze: failure === null
        ? jest.fn(async () => result(RESULT_A, 'pdf'))
        : jest.fn(async () => { throw failure; }),
    };
    const tempFiles = {
      cleanupAbandoned: jest.fn(async () => CLEAN),
      cleanupRequest: jest.fn(() => cleanup.promise),
    };
    const { coordinator } = harness({ api, tempFiles, cleanupTimeoutMs: 1_000 });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());

    const analysis = coordinator.commands.analyze();
    await flushPromises();
    expect(coordinator.getState().status).toBe('analyzing');
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await analysis;

    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A);
    expect(coordinator.getState().status).toBe(failure === null ? 'succeeded' : 'failed');
    expect(coordinator.getState().source).toBeNull();
  });

  it('awaits PDF cleanup after cancellation even if the API never settles', async () => {
    const pending = deferred<AnalysisResponse>();
    const cleanup = deferred<CleanupReceipt>();
    const cleanupStarted = deferred<void>();
    const tempFiles = {
      cleanupAbandoned: jest.fn(async () => CLEAN),
      cleanupRequest: jest.fn(() => {
        cleanupStarted.resolve();
        return cleanup.promise;
      }),
    };
    const { coordinator } = harness({
      api: { analyze: jest.fn(() => pending.promise) },
      tempFiles,
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    const analysis = coordinator.commands.analyze();
    await flushPromises();

    const cancellation = coordinator.commands.cancel();
    await cleanupStarted.promise;
    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A);
    expect(coordinator.getState().status).toBe('analyzing');
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([analysis, cancellation]);

    expect(coordinator.getState()).toMatchObject({ status: 'cancelled', source: null });
  });

  it('commits cancellation rather than success when cancel occurs during PDF cleanup', async () => {
    const cleanup = deferred<CleanupReceipt>();
    const tempFiles = {
      cleanupAbandoned: jest.fn(async () => CLEAN),
      cleanupRequest: jest.fn(() => cleanup.promise),
    };
    const { coordinator } = harness({
      api: { analyze: jest.fn(async () => result(RESULT_A, 'pdf')) },
      tempFiles,
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    const analysis = coordinator.commands.analyze();
    while (tempFiles.cleanupRequest.mock.calls.length === 0) await Promise.resolve();

    const cancellation = coordinator.commands.cancel();
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([analysis, cancellation]);

    expect(coordinator.getState()).toMatchObject({ status: 'cancelled', source: null, result: null });
  });

  it('does not retain a deleted PDF when a job edit aborts its active request', async () => {
    const pending = deferred<AnalysisResponse>();
    const { coordinator, tempFiles } = harness({
      api: { analyze: jest.fn(() => pending.promise) },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    void coordinator.commands.analyze();
    await flushPromises();

    await coordinator.commands.setJobDescription('updated private job draft');

    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A);
    expect(coordinator.getState()).toMatchObject({
      status: 'idle',
      source: null,
      jobDescription: 'updated private job draft',
    });
  });

  it('surfaces cleanup failure when a job edit races an active PDF terminal path', async () => {
    const pending = deferred<AnalysisResponse>();
    const cleanupRequest = jest.fn(async () => ({
      attempted: 1,
      deleted: 0,
      failed: 1,
      refused: 0,
    }));
    const { coordinator } = harness({
      api: { analyze: jest.fn(() => pending.promise) },
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    void coordinator.commands.analyze();
    await flushPromises();

    await coordinator.commands.setJobDescription('updated private job draft');

    expect(cleanupRequest).toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: pdfSource(),
      error: { category: 'privacy' },
      cleanupPending: true,
    });
  });

  it.each([
    ['failed receipt', async () => ({ attempted: 1, deleted: 0, failed: 1, refused: 0 })],
    ['refused receipt', async () => ({ attempted: 0, deleted: 0, failed: 0, refused: 1 })],
    ['inconsistent receipt', async () => ({ attempted: 2, deleted: 1, failed: 0, refused: 0 })],
    ['rejection', async () => { throw new Error('private native path'); }],
  ] as const)('blocks a false success for cleanup %s', async (_name, cleanupRequest) => {
    const { coordinator } = harness({
      api: { analyze: jest.fn(async () => result(RESULT_A, 'pdf')) },
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());

    await coordinator.commands.analyze();

    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      error: { category: 'privacy', retryable: false },
    });
    expect(coordinator.getState().result).toBeNull();
  });

  it('bounds a never-settling cleanup and retains a non-sensitive cleanup retry reference', async () => {
    jest.useFakeTimers();
    const never = new Promise<CleanupReceipt>(() => undefined);
    const { coordinator } = harness({
      api: { analyze: jest.fn(async () => result(RESULT_A, 'pdf')) },
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest: jest.fn(() => never),
      },
      cleanupTimeoutMs: 25,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    const analysis = coordinator.commands.analyze();
    await jest.advanceTimersByTimeAsync(25);
    await analysis;

    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      error: { category: 'privacy' },
      cleanupPending: true,
    });
    jest.useRealTimers();
  });

  it('blocks another upload while a prior PDF deletion remains unverified', async () => {
    const cleanupRequest = jest.fn(async () => ({
      attempted: 1,
      deleted: 0,
      failed: 1,
      refused: 0,
    }));
    const api = { analyze: jest.fn(async () => result(RESULT_A, 'pdf')) };
    const { coordinator } = harness({
      api,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();

    await coordinator.commands.analyze();

    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toMatchObject({ status: 'failed', cleanupPending: true });
  });

  it('allows an explicit edit to retry cleanup without re-uploading and clears the warning on proof', async () => {
    const cleanupRequest = jest.fn()
      .mockResolvedValueOnce({ attempted: 1, deleted: 0, failed: 1, refused: 0 })
      .mockResolvedValueOnce({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    const api = { analyze: jest.fn(async () => result(RESULT_A, 'pdf')) };
    const { coordinator } = harness({
      api,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();

    await coordinator.commands.setJobDescription('updated private job draft');

    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(cleanupRequest).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toMatchObject({
      status: 'idle',
      source: null,
      jobDescription: 'updated private job draft',
      cleanupPending: false,
    });
  });

  it('never asks the file registry to clean a text source', async () => {
    const { coordinator, tempFiles } = await readyHarness();
    await coordinator.commands.analyze();
    expect(tempFiles.cleanupRequest).not.toHaveBeenCalled();
  });

  it('does not let stale source-replacement cleanup overwrite a later source', async () => {
    const cleanup = deferred<CleanupReceipt>();
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest: jest.fn(() => cleanup.promise),
      },
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource(REQUEST_A));
    const firstReplacement = coordinator.commands.selectSource(textSource('middle'));
    await flushPromises();
    const lastReplacement = coordinator.commands.selectSource(textSource('latest'));
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([firstReplacement, lastReplacement]);

    expect(coordinator.getState()).toMatchObject({ source: textSource('latest') });
  });
});

describe('disposal and sensitive-data boundary', () => {
  it('marks the coordinator disposed before aborting and awaits PDF cleanup without later commits', async () => {
    const pending = deferred<AnalysisResponse>();
    const cleanup = deferred<CleanupReceipt>();
    const api = { analyze: jest.fn((_request: unknown, _signal: AbortSignal) => pending.promise) };
    const tempFiles = {
      cleanupAbandoned: jest.fn(async () => CLEAN),
      cleanupRequest: jest.fn(() => cleanup.promise),
    };
    const { coordinator } = harness({ api, tempFiles, cleanupTimeoutMs: 1_000 });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    void coordinator.commands.analyze();
    await flushPromises();

    const disposal = coordinator.dispose();
    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(api.analyze.mock.calls[0]?.[1].aborted).toBe(true);
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await disposal;
    pending.resolve(result(RESULT_A, 'pdf'));
    await flushPromises();

    expect(coordinator.getState()).toMatchObject({ source: null, jobDescription: '', result: null });
  });

  it('does not persist, log, or leak raw private causes while coordinating', async () => {
    const secret = 'private-person@example.test /Users/name/Resume Secret.pdf';
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api, consentStore, coordinator } = await readyHarness();
    await coordinator.commands.selectSource(textSource(secret));
    api.analyze.mockRejectedValueOnce(new Error(secret));

    await coordinator.commands.analyze();

    expect(consentStore.grant).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(JSON.stringify(coordinator.getState().error)).not.toContain(secret);
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      error: { category: 'network', retryable: false },
    });
    consoleError.mockRestore();
  });
});
