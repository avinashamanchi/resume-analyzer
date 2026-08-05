import validFixture from '../../contracts/fixtures/analysis-valid.json';

import {
  AnalysisCoordinator,
  type AnalysisCoordinatorOptions,
  type PdfPickAuthority,
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
const LEASE_A = Symbol();
const LEASE_B = Symbol();
const PDF_LEASES = new Map<string, symbol>([
  [REQUEST_A, LEASE_A],
  [REQUEST_B, LEASE_B],
]);
const CLEAN: CleanupReceipt = { attempted: 0, deleted: 0, failed: 0, refused: 0 };
const OWNED_PDF_PATTERN = /^file:\/\/\/app\/cache\/resume-ai-v1\/([0-9a-f-]+)\/([0-9a-f-]+\.pdf)$/;

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

function leaseFor(requestId: string): symbol {
  let lease = PDF_LEASES.get(requestId);
  if (lease === undefined) {
    lease = Symbol();
    PDF_LEASES.set(requestId, lease);
  }
  return lease;
}

function pdfSource(
  requestId = REQUEST_A,
  lease = leaseFor(requestId),
): Extract<ResumeSource, { kind: 'pdf' }> {
  return {
    kind: 'pdf',
    requestId,
    uri: `file:///app/cache/resume-ai-v1/${requestId}/11111111-1111-4111-8111-111111111111.pdf`,
    size: 1_024,
    lease,
  };
}

function leasedPdfSource(
  requestId = REQUEST_A,
  lease = requestId === REQUEST_A ? LEASE_A : LEASE_B,
): Extract<ResumeSource, { kind: 'pdf' }> {
  return pdfSource(requestId, lease);
}

function leasedPdfOwnership(expectedLease = LEASE_A) {
  const assertOwnedFileUri = jest.fn((uri: unknown) => {
    if (typeof uri !== 'string') throw new Error('not owned');
    const match = OWNED_PDF_PATTERN.exec(uri);
    if (match === null) throw new Error('not owned');
    return { requestId: match[1], uri };
  });
  return {
    assertOwnedFileUri,
    inspectOwnedFileUri: jest.fn(async (
      uri: unknown,
      _requestId?: string,
      _lease?: symbol,
    ) => ({
      ...assertOwnedFileUri(uri),
      lease: expectedLease,
      exists: true,
      size: 1_024,
    })),
  };
}

function visionSource(reviewed: boolean): ResumeSource {
  return { kind: 'vision_text', text: 'Reviewed resume text', reviewed, pageCount: 2 };
}

function pdfOwnership() {
  const missing = new Set<string>();
  const assertOwnedFileUri = jest.fn((uri: unknown) => {
    if (typeof uri !== 'string') throw new Error('not owned');
    const match = OWNED_PDF_PATTERN.exec(uri);
    if (match === null) throw new Error('not owned');
    return { requestId: match[1], uri };
  });
  return {
    assertOwnedFileUri,
    inspectOwnedFileUri: jest.fn(async (
      uri: unknown,
      _requestId: string,
      lease: symbol,
    ) => {
      const owned = assertOwnedFileUri(uri);
      return {
        ...owned,
        lease,
        exists: !missing.has(owned.requestId),
        size: 1_024,
      };
    }),
    markMissing(requestId: string) { missing.add(requestId); },
  };
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
    cleanupRequest: jest.fn(async (_requestId: string, _lease: symbol) => CLEAN),
  };
  const ownership = pdfOwnership();
  const coordinator = new AnalysisCoordinator({
    api,
    consentStore,
    tempFiles,
    pdfOwnership: ownership,
    cleanupTimeoutMs: 50,
    ...overrides,
  });
  return {
    api,
    consentStore,
    coordinator,
    pdfOwnership: ownership,
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

function failAbandonedPick(
  coordinator: AnalysisCoordinator,
  authority: PdfPickAuthority,
): Promise<void> {
  return coordinator.commands.failPdfPick(authority, 'abandoned_cleanup_required');
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

describe('review fixes: Task 10 ownership authority', () => {
  it('returns the exact committed PDF identity and generation as its selection receipt', async () => {
    const { coordinator } = harness();
    const source = pdfSource();
    await coordinator.initialize();

    const selection = await coordinator.commands.selectSource(source);

    expect(selection).toEqual({
      committed: true,
      sourceIdentity: source.lease,
      generation: coordinator.getState().generation,
    });
  });

  it('rejects a suffix-identical external PDF with zero API calls', async () => {
    const { api, coordinator, pdfOwnership: ownership, tempFiles } = harness();
    await coordinator.initialize();
    const external = {
      ...pdfSource(),
      uri: `file:///external/resume-ai-v1/${REQUEST_A}/11111111-1111-4111-8111-111111111111.pdf`,
    };

    const selection = await coordinator.commands.selectSource(external);
    await coordinator.commands.analyze();

    expect(ownership.assertOwnedFileUri).toHaveBeenCalledWith(external.uri);
    expect(api.analyze).not.toHaveBeenCalled();
    expect(tempFiles.cleanupRequest).not.toHaveBeenCalled();
    expect(selection).toEqual({ committed: false });
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: null,
      error: { category: 'validation' },
    });
  });

  it('requires ownership authority to return the exact declared request ID', async () => {
    const ownership = {
      assertOwnedFileUri: jest.fn((uri: unknown) => ({ requestId: REQUEST_B, uri: String(uri) })),
      inspectOwnedFileUri: jest.fn(async (uri: unknown, _requestId: string, lease: symbol) => ({
        requestId: REQUEST_B,
        uri: String(uri),
        lease,
        exists: true,
        size: 1_024,
      })),
    };
    const { api, coordinator, tempFiles } = harness({ pdfOwnership: ownership });
    await coordinator.initialize();

    await coordinator.commands.selectSource(pdfSource(REQUEST_A));
    await coordinator.commands.analyze();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_B, LEASE_A);
    expect(coordinator.getState()).toMatchObject({ status: 'failed', source: null });
  });
});

describe('review fixes: non-reentrant mutation transactions', () => {
  it('does not expose an analyzable ready state while source replacement cleanup is pending', async () => {
    const cleanup = deferred<CleanupReceipt>();
    const cleanupRequest = jest.fn((requestId: string) =>
      requestId === REQUEST_A ? cleanup.promise : Promise.resolve(CLEAN),
    );
    const { api, coordinator } = harness({
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource(REQUEST_A));

    const replacement = coordinator.commands.selectSource(textSource('replacement text'));
    await flushPromises();
    const blockedAnalyze = coordinator.commands.analyze();
    await flushPromises();

    expect(coordinator.getState()).toMatchObject({ mutation: 'selecting' });
    expect(api.analyze).not.toHaveBeenCalled();
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([replacement, blockedAnalyze]);
    expect(coordinator.getState()).toMatchObject({
      mutation: 'none',
      status: 'ready',
      source: textSource('replacement text'),
    });
  });

  it('isolates throwing subscribers and blocks their reentrant Analyze call until an edit commits', async () => {
    const { api, coordinator } = await readyHarness();
    let reentered = false;
    let secondSubscriberCalls = 0;
    const unsubscribeThrower = coordinator.subscribe(() => {
      if (reentered) return;
      reentered = true;
      void coordinator.commands.analyze();
      throw new Error('subscriber private failure');
    });
    const unsubscribeSecond = coordinator.subscribe(() => { secondSubscriberCalls += 1; });

    await expect(coordinator.commands.setJobDescription('new job draft')).resolves.toEqual({
      committed: true,
      generation: coordinator.getState().generation,
    });

    expect(api.analyze).not.toHaveBeenCalled();
    expect(secondSubscriberCalls).toBeGreaterThan(0);
    expect(coordinator.getState()).toMatchObject({
      mutation: 'none',
      status: 'ready',
      jobDescription: 'new job draft',
    });
    unsubscribeThrower();
    unsubscribeSecond();
  });

  it('blocks Analyze while reset waits for verified PDF cleanup', async () => {
    const cleanup = deferred<CleanupReceipt>();
    const { api, coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest: jest.fn(() => cleanup.promise),
      },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());

    const reset = coordinator.commands.reset();
    await flushPromises();
    const blockedAnalyze = coordinator.commands.analyze();
    await flushPromises();
    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({ mutation: 'resetting' });

    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([reset, blockedAnalyze]);
    expect(coordinator.getState()).toMatchObject({ mutation: 'none', status: 'idle', source: null });
  });
});

describe('review fixes: PDF consent exits', () => {
  it('decline invalidates a pending consent grant so late persistence never uploads', async () => {
    const grant = deferred<void>();
    const { api, consentStore, coordinator, setConsent } = harness();
    setConsent(false);
    consentStore.grant.mockImplementationOnce(() => grant.promise);
    await coordinator.initialize();
    await coordinator.commands.selectSource(textSource());
    await coordinator.commands.analyze();
    const granting = coordinator.commands.grantConsent();
    await flushPromises();

    const decline = coordinator.commands.declineConsent();
    grant.resolve();
    await Promise.all([granting, decline]);

    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({ status: 'ready', source: textSource() });
  });

  it('awaits verified PDF cleanup before exposing a consent-read failure', async () => {
    const cleanup = deferred<CleanupReceipt>();
    const consentStore = {
      hasCurrentConsent: jest.fn(async () => { throw new Error('private consent read'); }),
      grant: jest.fn(async () => undefined),
    };
    const { api, coordinator } = harness({
      consentStore,
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest: jest.fn(() => cleanup.promise),
      },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());

    const analysis = coordinator.commands.analyze();
    await flushPromises();
    expect(coordinator.getState().source).toMatchObject({ kind: 'pdf' });
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await analysis;

    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: null,
      error: { category: 'consent_storage' },
    });
  });

  it('cleans a PDF after consent persistence failure without uploading', async () => {
    const { api, consentStore, coordinator, setConsent, tempFiles } = harness();
    setConsent(false);
    consentStore.grant.mockRejectedValueOnce(new Error('private consent write'));
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();

    await coordinator.commands.grantConsent();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: null,
      error: { category: 'consent_storage' },
    });
  });

  it('cleans a PDF when cancellation aborts a never-settling consent read', async () => {
    const consent = deferred<boolean>();
    const { api, consentStore, coordinator, tempFiles } = harness();
    consentStore.hasCurrentConsent.mockImplementationOnce(() => consent.promise);
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    const analysis = coordinator.commands.analyze();
    await flushPromises();

    await coordinator.commands.cancel();
    await analysis;

    expect(api.analyze).not.toHaveBeenCalled();
    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(coordinator.getState()).toMatchObject({ status: 'cancelled', source: null });
  });

  it.each(['decline', 'background'] as const)(
    '%s leaves consentRequired only after cleaning the staged PDF',
    async exit => {
      const { api, coordinator, setConsent, tempFiles } = harness();
      setConsent(false);
      await coordinator.initialize();
      await coordinator.commands.selectSource(pdfSource());
      await coordinator.commands.analyze();
      expect(coordinator.getState().status).toBe('consentRequired');

      if (exit === 'decline') await coordinator.commands.declineConsent();
      else await coordinator.handleAppState('background');

      expect(api.analyze).not.toHaveBeenCalled();
      expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
      expect(coordinator.getState()).toMatchObject({
        status: exit === 'decline' ? 'idle' : 'cancelled',
        source: null,
      });
    },
  );

  it('background keeps a consent-gated PDF privacy-blocked when lifecycle cleanup fails', async () => {
    const cleanupRequest = jest.fn(async () => ({
      attempted: 1,
      deleted: 0,
      failed: 1,
      refused: 0,
    }));
    const { api, coordinator, setConsent } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest,
      },
    });
    setConsent(false);
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();
    expect(coordinator.getState().status).toBe('consentRequired');

    await coordinator.handleAppState('background');

    expect(api.analyze).not.toHaveBeenCalled();
    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: pdfSource(),
      cleanupPending: true,
      lifecycleEpoch: 1,
      error: { category: 'privacy' },
    });
  });

  it('privacy cleanup failure overrides a PDF consent-read error', async () => {
    const { coordinator } = harness({
      consentStore: {
        hasCurrentConsent: jest.fn(async () => { throw new Error('private consent read'); }),
        grant: jest.fn(async () => undefined),
      },
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest: jest.fn(async () => ({ attempted: 1, deleted: 0, failed: 1, refused: 0 })),
      },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();

    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: pdfSource(),
      cleanupPending: true,
      error: { category: 'privacy' },
    });
  });
});

describe('review fixes: concurrent staged PDF ownership', () => {
  it('never commits a duplicate pending claim after the superseded owner deletes it', async () => {
    const startup = deferred<CleanupReceipt>();
    const cleanupRequest = jest.fn(async () => ({
      attempted: 1,
      deleted: 1,
      failed: 0,
      refused: 0,
    }));
    const { api, coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(() => startup.promise),
        cleanupRequest,
      },
      cleanupTimeoutMs: 1_000,
    });

    const first = coordinator.commands.selectSource(pdfSource(REQUEST_B));
    const second = coordinator.commands.selectSource(pdfSource(REQUEST_B));
    startup.resolve(CLEAN);
    await Promise.all([first, second]);
    await coordinator.commands.analyze();

    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_B, LEASE_B);
    expect(api.analyze).not.toHaveBeenCalled();
    expect(coordinator.getState().source).toBeNull();
  });

  it.each(['reset', 'replacement', 'dispose'] as const)(
    '%s cleans pending PDF B when it supersedes B while prior PDF A cleanup is pending',
    async nextCommand => {
      const cleanupA = deferred<CleanupReceipt>();
      const cleanupRequest = jest.fn((requestId: string) =>
        requestId === REQUEST_A
          ? cleanupA.promise
          : Promise.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 }),
      );
      const { coordinator } = harness({
        tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
        cleanupTimeoutMs: 1_000,
      });
      await coordinator.initialize();
      await coordinator.commands.selectSource(pdfSource(REQUEST_A));
      const selectingB = coordinator.commands.selectSource(pdfSource(REQUEST_B));
      await flushPromises();

      let superseding: Promise<unknown>;
      if (nextCommand === 'reset') superseding = coordinator.commands.reset();
      else if (nextCommand === 'replacement') {
        superseding = coordinator.commands.selectSource(textSource('replacement C'));
      } else superseding = coordinator.dispose();
      cleanupA.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
      await Promise.all([selectingB, superseding]);

      expect(cleanupRequest.mock.calls.map(call => call[0])).toContain(REQUEST_B);
      if (nextCommand !== 'dispose') expect(coordinator.getState().source?.kind).not.toBe('pdf');
    },
  );

  it('cleans incoming PDF B when prior PDF A cleanup fails before B can commit', async () => {
    const cleanupRequest = jest.fn(async (requestId: string) =>
      requestId === REQUEST_A
        ? { attempted: 1, deleted: 0, failed: 1, refused: 0 }
        : { attempted: 1, deleted: 1, failed: 0, refused: 0 },
    );
    const { coordinator } = harness({
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource(REQUEST_A));

    const selection = await coordinator.commands.selectSource(pdfSource(REQUEST_B));

    expect(cleanupRequest.mock.calls.map(call => call[0])).toEqual([REQUEST_A, REQUEST_B]);
    expect(selection).toEqual({ committed: false });
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: pdfSource(REQUEST_A),
      cleanupPending: true,
      error: { category: 'privacy' },
    });
  });
});

describe('review fixes: live single-use PDF ownership', () => {
  it('never recommits the same PDF while Analyze cleanup is deleting it', async () => {
    const deletion = deferred<CleanupReceipt>();
    const ownership = pdfOwnership();
    const cleanupRequest = jest.fn(async (requestId: string) => {
      const receipt = await deletion.promise;
      ownership.markMissing(requestId);
      return receipt;
    });
    const { api, coordinator } = harness({
      pdfOwnership: ownership,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());

    const analysis = coordinator.commands.analyze();
    await flushPromises();
    expect(api.analyze).toHaveBeenCalledTimes(1);
    const staleReselection = coordinator.commands.selectSource(pdfSource());

    deletion.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([analysis, staleReselection]);
    const callsAfterCleanup = api.analyze.mock.calls.length;
    await coordinator.commands.analyze();

    expect(coordinator.getState()).not.toMatchObject({
      status: 'ready',
      source: { kind: 'pdf', requestId: REQUEST_A },
    });
    expect(api.analyze).toHaveBeenCalledTimes(callsAfterCleanup);
  });

  it('never recommits the same PDF while reset cleanup is deleting it', async () => {
    const deletion = deferred<CleanupReceipt>();
    const ownership = pdfOwnership();
    const cleanupRequest = jest.fn(async (requestId: string) => {
      const receipt = await deletion.promise;
      ownership.markMissing(requestId);
      return receipt;
    });
    const { api, coordinator } = harness({
      pdfOwnership: ownership,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());

    const reset = coordinator.commands.reset();
    await flushPromises();
    const staleReselection = coordinator.commands.selectSource(pdfSource());
    deletion.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([reset, staleReselection]);
    await coordinator.commands.analyze();

    expect(coordinator.getState()).not.toMatchObject({
      status: 'ready',
      source: { kind: 'pdf', requestId: REQUEST_A },
    });
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('never recommits the same PDF while source-replacement cleanup is deleting it', async () => {
    const deletion = deferred<CleanupReceipt>();
    const ownership = pdfOwnership();
    const cleanupRequest = jest.fn(async (requestId: string) => {
      const receipt = await deletion.promise;
      ownership.markMissing(requestId);
      return receipt;
    });
    const { api, coordinator } = harness({
      pdfOwnership: ownership,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());

    const replacement = coordinator.commands.selectSource(textSource('replacement text'));
    await flushPromises();
    const staleReselection = coordinator.commands.selectSource(pdfSource());
    deletion.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await Promise.all([replacement, staleReselection]);
    await coordinator.commands.analyze();

    expect(coordinator.getState()).not.toMatchObject({
      status: 'ready',
      source: { kind: 'pdf', requestId: REQUEST_A },
    });
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('rejects a stale PDF source through live inspection after its cleanup completed', async () => {
    const ownership = pdfOwnership();
    const cleanupRequest = jest.fn(async (requestId: string) => {
      ownership.markMissing(requestId);
      return { attempted: 1, deleted: 1, failed: 0, refused: 0 };
    });
    const { api, coordinator } = harness({
      pdfOwnership: ownership,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.reset();

    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();

    expect(coordinator.getState()).not.toMatchObject({
      status: 'ready',
      source: { kind: 'pdf', requestId: REQUEST_A },
    });
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('releases each claim so live inspection, not accumulated tombstones, rejects stale PDFs', async () => {
    const ownership = pdfOwnership();
    const cleanupRequest = jest.fn(async (requestId: string) => {
      ownership.markMissing(requestId);
      return { attempted: 1, deleted: 1, failed: 0, refused: 0 };
    });
    const { api, coordinator } = harness({
      pdfOwnership: ownership,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();

    const requestCount = 32;
    for (let index = 1; index <= requestCount; index += 1) {
      const requestId = `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-${index
        .toString(16)
        .padStart(12, '0')}`;
      const source = pdfSource(requestId);
      await coordinator.commands.selectSource(source);
      expect(coordinator.getState().source).toMatchObject({ kind: 'pdf', requestId });

      await coordinator.commands.reset();
      const inspectionsBeforeStaleReuse = ownership.inspectOwnedFileUri.mock.calls.length;
      await coordinator.commands.selectSource(source);

      expect(ownership.inspectOwnedFileUri).toHaveBeenCalledTimes(inspectionsBeforeStaleReuse + 1);
      expect(coordinator.getState().source).toBeNull();
    }

    expect(ownership.inspectOwnedFileUri).toHaveBeenCalledTimes(requestCount * 2);
    expect(cleanupRequest).toHaveBeenCalledTimes(requestCount * 2);
    await coordinator.commands.analyze();
    expect(api.analyze).not.toHaveBeenCalled();
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

  it('rejects and cleans a PDF selected while abandoned cleanup is still checking privacy', async () => {
    const recovery = deferred<void>();
    const ownership = pdfOwnership();
    const cleanupAbandoned = jest.fn(async () => {
      await recovery.promise;
      ownership.markMissing(REQUEST_A);
      return { attempted: 1, deleted: 1, failed: 0, refused: 0 };
    });
    const cleanupRequest = jest.fn(async (requestId: string) => {
      await recovery.promise;
      ownership.markMissing(requestId);
      return CLEAN;
    });
    const { api, coordinator } = harness({
      pdfOwnership: ownership,
      tempFiles: { cleanupAbandoned, cleanupRequest },
      cleanupTimeoutMs: 1_000,
    });

    const initialization = coordinator.initialize();
    const selection = coordinator.commands.selectSource(pdfSource());
    await flushPromises();
    expect(coordinator.getState().privacyReadiness).toBe('checking');
    recovery.resolve();
    await Promise.all([initialization, selection]);
    await coordinator.commands.analyze();

    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(coordinator.getState().source).toBeNull();
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it.each(['initialization-first', 'rejection-first'] as const)(
    'blocks privacy when early PDF cleanup fails in %s settlement order',
    async settlementOrder => {
      const recovery = deferred<CleanupReceipt>();
      const rejection = deferred<CleanupReceipt>();
      const { api, coordinator } = harness({
        tempFiles: {
          cleanupAbandoned: jest.fn(() => recovery.promise),
          cleanupRequest: jest.fn(() => rejection.promise),
        },
        cleanupTimeoutMs: 1_000,
      });
      const observedReadiness: string[] = [];
      const unsubscribe = coordinator.subscribe(() => {
        observedReadiness.push(coordinator.getState().privacyReadiness);
      });

      const initialization = coordinator.initialize();
      const selection = coordinator.commands.selectSource(pdfSource());
      if (settlementOrder === 'initialization-first') {
        recovery.resolve(CLEAN);
        await flushPromises();
        expect(coordinator.getState().privacyReadiness).toBe('checking');
        rejection.resolve({ attempted: 1, deleted: 0, failed: 1, refused: 0 });
      } else {
        rejection.resolve({ attempted: 1, deleted: 0, failed: 1, refused: 0 });
        await selection;
        recovery.resolve(CLEAN);
      }
      await Promise.all([initialization, selection]);
      await coordinator.commands.selectSource(pdfSource(REQUEST_B));
      await coordinator.commands.analyze();

      expect(observedReadiness).not.toContain('ready');
      expect(coordinator.getState()).toMatchObject({
        privacyReadiness: 'blocked',
        status: 'failed',
        source: null,
        cleanupPending: true,
        error: { category: 'privacy' },
      });
      expect(api.analyze).not.toHaveBeenCalled();
      unsubscribe();
    },
  );

  it('blocks privacy after early PDF cleanup times out and ignores its late settlement', async () => {
    jest.useFakeTimers();
    try {
      const recovery = deferred<CleanupReceipt>();
      const lateCleanup = deferred<CleanupReceipt>();
      const cleanupRequest = jest.fn((requestId: string) => requestId === REQUEST_A
        ? lateCleanup.promise
        : Promise.resolve(CLEAN));
      const { api, coordinator } = harness({
        tempFiles: { cleanupAbandoned: jest.fn(() => recovery.promise), cleanupRequest },
        cleanupTimeoutMs: 50,
      });
      const observedReadiness: string[] = [];
      coordinator.subscribe(() => {
        observedReadiness.push(coordinator.getState().privacyReadiness);
      });

      const initialization = coordinator.initialize();
      const selection = coordinator.commands.selectSource(pdfSource());
      recovery.resolve(CLEAN);
      await flushPromises();
      expect(coordinator.getState().privacyReadiness).toBe('checking');

      jest.advanceTimersByTime(51);
      await flushPromises(12);
      await Promise.all([initialization, selection]);
      expect(coordinator.getState()).toMatchObject({
        privacyReadiness: 'blocked',
        cleanupPending: true,
        error: { category: 'privacy' },
      });

      lateCleanup.resolve(CLEAN);
      await flushPromises();
      await coordinator.commands.selectSource(pdfSource(REQUEST_B));
      await coordinator.commands.analyze();

      expect(observedReadiness).not.toContain('ready');
      expect(coordinator.getState()).toMatchObject({
        privacyReadiness: 'blocked',
        source: null,
        cleanupPending: true,
      });
      expect(api.analyze).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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

describe('quarantined native-picker cleanup recovery', () => {
  it('accepts a cleanup obligation from a superseded but genuinely issued picker authority', async () => {
    const cleanupAbandoned = jest.fn(async () => CLEAN);
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned,
        cleanupRequest: jest.fn(async () => CLEAN),
      },
    });
    await coordinator.initialize();
    const superseded = coordinator.commands.beginPdfPick(new AbortController().signal);
    coordinator.commands.beginPdfPick(new AbortController().signal);

    await failAbandonedPick(coordinator, superseded);

    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'blocked',
      cleanupPending: true,
      error: { category: 'privacy' },
    });
    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(true);
    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);
  });

  it('ignores a fabricated picker authority without inventing a cleanup obligation', async () => {
    const cleanupAbandoned = jest.fn(async () => CLEAN);
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned,
        cleanupRequest: jest.fn(async () => CLEAN),
      },
    });
    await coordinator.initialize();

    await failAbandonedPick(coordinator, Symbol('fabricated'));

    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'ready',
      cleanupPending: false,
      error: null,
    });
    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(false);
    expect(cleanupAbandoned).toHaveBeenCalledTimes(1);
  });

  it('keeps an abandoned obligation blocked after exact cleanup of a colliding picker lease', async () => {
    const cleanupAbandoned = jest.fn()
      .mockResolvedValueOnce(CLEAN)
      .mockResolvedValueOnce({ attempted: 0, deleted: 0, failed: 0, refused: 1 });
    const cleanupRequest = jest.fn(async () => CLEAN);
    const { coordinator } = harness({
      tempFiles: { cleanupAbandoned, cleanupRequest },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(leasedPdfSource(REQUEST_A, LEASE_A));
    const abandoned = coordinator.commands.beginPdfPick(new AbortController().signal);
    const collision = coordinator.commands.beginPdfPick(new AbortController().signal);
    await failAbandonedPick(coordinator, abandoned);

    await expect(coordinator.commands.completePdfPick(
      collision,
      leasedPdfSource(REQUEST_A, LEASE_B),
    )).resolves.toEqual({ committed: false });

    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_B);
    expect(cleanupRequest).not.toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'blocked',
      cleanupPending: true,
      error: { category: 'privacy' },
    });
    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(false);
    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);
    expect(coordinator.getState().privacyReadiness).toBe('blocked');
  });

  it('accepts exact B cleanup refusal only while a different exact A lease remains authoritative', async () => {
    const cleanupRequest = jest.fn(async (_requestId: string, lease: symbol) =>
      lease === LEASE_B
        ? { attempted: 0, deleted: 0, failed: 0, refused: 1 }
        : CLEAN,
    );
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest,
      },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(leasedPdfSource(REQUEST_A, LEASE_A));
    const staleSignal = new AbortController();
    const staleAuthority = coordinator.commands.beginPdfPick(staleSignal.signal);
    staleSignal.abort();

    await expect(coordinator.commands.completePdfPick(
      staleAuthority,
      leasedPdfSource(REQUEST_A, LEASE_B),
    )).resolves.toEqual({ committed: false });

    expect(cleanupRequest).toHaveBeenCalledTimes(1);
    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_B);
    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'ready',
      cleanupPending: false,
      source: { kind: 'pdf', requestId: REQUEST_A, lease: LEASE_A },
    });
  });

  it('blocks a delayed B cleanup refusal after the different A claim has released', async () => {
    const cleanupB = deferred<CleanupReceipt>();
    const cleanupRequest = jest.fn((_requestId: string, lease: symbol) =>
      lease === LEASE_B ? cleanupB.promise : Promise.resolve(CLEAN),
    );
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: jest.fn(async () => CLEAN),
        cleanupRequest,
      },
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(leasedPdfSource(REQUEST_A, LEASE_A));
    const staleSignal = new AbortController();
    const staleAuthority = coordinator.commands.beginPdfPick(staleSignal.signal);
    staleSignal.abort();
    const collision = coordinator.commands.completePdfPick(
      staleAuthority,
      leasedPdfSource(REQUEST_A, LEASE_B),
    );
    await flushPromises();
    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_B);

    await coordinator.commands.reset();
    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    cleanupB.resolve({ attempted: 0, deleted: 0, failed: 0, refused: 1 });
    await expect(collision).resolves.toEqual({ committed: false });

    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'blocked',
      cleanupPending: true,
      source: null,
      error: { category: 'privacy' },
    });
  });

  it('keeps an abandoned obligation blocked across reset, lifecycle return, picks, and text selection', async () => {
    const cleanupAbandoned = jest.fn(async () => CLEAN);
    const { coordinator, tempFiles } = harness({
      tempFiles: {
        cleanupAbandoned,
        cleanupRequest: jest.fn(async () => CLEAN),
      },
    });
    await coordinator.initialize();
    const authority = coordinator.commands.beginPdfPick(new AbortController().signal);

    await failAbandonedPick(coordinator, authority);
    await coordinator.commands.reset();
    await coordinator.handleAppState('active');
    const laterAuthority = coordinator.commands.beginPdfPick(new AbortController().signal);
    await coordinator.commands.completePdfPick(laterAuthority, null);
    await expect(coordinator.commands.selectSource(textSource('later private resume')))
      .resolves.toEqual({ committed: false });

    expect(cleanupAbandoned).toHaveBeenCalledTimes(1);
    expect(tempFiles.cleanupRequest).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      privacyReadiness: 'blocked',
      source: null,
      cleanupPending: true,
      error: { category: 'privacy', retryable: false },
    });
  });

  it.each([
    ['failed', { attempted: 1, deleted: 0, failed: 1, refused: 0 }],
    ['refused', { attempted: 0, deleted: 0, failed: 0, refused: 1 }],
    ['inconsistent', { attempted: 2, deleted: 1, failed: 0, refused: 0 }],
    ['malformed', { attempted: 1, deleted: 1, failed: 0, refused: 0, path: '/private/cache/resume.pdf' }],
  ] as const)('retains a content-free obligation after a %s abandoned receipt', async (_label, receipt) => {
    const cleanupAbandoned = jest.fn()
      .mockResolvedValueOnce(CLEAN)
      .mockResolvedValueOnce(receipt);
    const cleanupRequest = jest.fn(async () => CLEAN);
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned: cleanupAbandoned as unknown as AnalysisCoordinatorOptions['tempFiles']['cleanupAbandoned'],
        cleanupRequest,
      },
    });
    await coordinator.initialize();
    const authority = coordinator.commands.beginPdfPick(new AbortController().signal);
    await failAbandonedPick(coordinator, authority);

    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(false);

    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);
    expect(cleanupRequest).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'blocked',
      source: null,
      cleanupPending: true,
      error: { category: 'privacy' },
    });
    expect(JSON.stringify(coordinator.getState())).not.toContain('/private/cache/resume.pdf');
  });

  it('retains a content-free obligation when abandoned recovery throws a private cause', async () => {
    const privateCause = 'file:///private/provider/private-resume.pdf';
    const cleanupAbandoned = jest.fn()
      .mockResolvedValueOnce(CLEAN)
      .mockRejectedValueOnce(new Error(privateCause));
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned,
        cleanupRequest: jest.fn(async () => CLEAN),
      },
    });
    await coordinator.initialize();
    const authority = coordinator.commands.beginPdfPick(new AbortController().signal);
    await failAbandonedPick(coordinator, authority);

    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(false);

    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'blocked',
      source: null,
      cleanupPending: true,
      error: { category: 'privacy' },
    });
    expect(JSON.stringify(coordinator.getState())).not.toContain(privateCause);
  });

  it('bounds recovery and disposal without reporting privacy ready when cleanup never settles', async () => {
    jest.useFakeTimers();
    try {
      const never = new Promise<CleanupReceipt>(() => undefined);
      const cleanupAbandoned = jest.fn()
        .mockResolvedValueOnce(CLEAN)
        .mockImplementation(() => never);
      const { coordinator } = harness({
        tempFiles: {
          cleanupAbandoned,
          cleanupRequest: jest.fn(async () => CLEAN),
        },
        cleanupTimeoutMs: 25,
      });
      await coordinator.initialize();
      const authority = coordinator.commands.beginPdfPick(new AbortController().signal);
      await failAbandonedPick(coordinator, authority);

      const recovery = coordinator.commands.recoverPrivacyCleanup();
      await jest.advanceTimersByTimeAsync(25);
      await expect(recovery).resolves.toBe(false);
      expect(coordinator.getState().privacyReadiness).toBe('blocked');

      const disposal = coordinator.dispose();
      await jest.advanceTimersByTimeAsync(25);
      await disposal;
      expect(cleanupAbandoned).toHaveBeenCalledTimes(3);
      expect(coordinator.getState().privacyReadiness).toBe('blocked');
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears a verified abandoned obligation once and never reconstructs an exact lease', async () => {
    const cleanupAbandoned = jest.fn()
      .mockResolvedValueOnce(CLEAN)
      .mockResolvedValueOnce({ attempted: 2, deleted: 2, failed: 0, refused: 0 });
    const cleanupRequest = jest.fn(async () => CLEAN);
    const { coordinator } = harness({
      tempFiles: { cleanupAbandoned, cleanupRequest },
    });
    await coordinator.initialize();
    const authority = coordinator.commands.beginPdfPick(new AbortController().signal);
    await failAbandonedPick(coordinator, authority);

    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(true);
    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(false);

    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);
    expect(cleanupRequest).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({
      status: 'idle',
      privacyReadiness: 'ready',
      source: null,
      error: null,
      cleanupPending: false,
    });
  });

  it('coalesces concurrent explicit recovery without duplicating fenced abandoned cleanup', async () => {
    const cleanup = deferred<CleanupReceipt>();
    const cleanupAbandoned = jest.fn()
      .mockResolvedValueOnce(CLEAN)
      .mockImplementationOnce(() => cleanup.promise);
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned,
        cleanupRequest: jest.fn(async () => CLEAN),
      },
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    const authority = coordinator.commands.beginPdfPick(new AbortController().signal);
    await failAbandonedPick(coordinator, authority);

    const first = coordinator.commands.recoverPrivacyCleanup();
    const second = coordinator.commands.recoverPrivacyCleanup();
    await flushPromises();
    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);

    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);
  });

  it('serializes abandoned recovery behind an in-flight exact cleanup mutation', async () => {
    const exactCleanup = deferred<CleanupReceipt>();
    const cleanupAbandoned = jest.fn(async () => CLEAN);
    const { coordinator } = harness({
      tempFiles: {
        cleanupAbandoned,
        cleanupRequest: jest.fn(() => exactCleanup.promise),
      },
      cleanupTimeoutMs: 1_000,
    });
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    const authority = coordinator.commands.beginPdfPick(new AbortController().signal);
    await failAbandonedPick(coordinator, authority);

    const reset = coordinator.commands.reset();
    const recovery = coordinator.commands.recoverPrivacyCleanup();
    await flushPromises();
    expect(cleanupAbandoned).toHaveBeenCalledTimes(1);

    exactCleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await reset;
    await expect(recovery).resolves.toBe(true);
    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'ready',
      cleanupPending: false,
      source: null,
    });
  });

  it('recovers both an exact stale-picker claim and an abandoned obligation before readiness', async () => {
    const cleanupRequest = jest.fn()
      .mockResolvedValueOnce({ attempted: 1, deleted: 0, failed: 1, refused: 0 })
      .mockResolvedValueOnce({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    const cleanupAbandoned = jest.fn()
      .mockResolvedValueOnce(CLEAN)
      .mockResolvedValueOnce({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    const { coordinator } = harness({
      tempFiles: { cleanupAbandoned, cleanupRequest },
    });
    await coordinator.initialize();
    const staleSignal = new AbortController();
    const staleAuthority = coordinator.commands.beginPdfPick(staleSignal.signal);
    staleSignal.abort();
    await coordinator.commands.completePdfPick(staleAuthority, pdfSource());
    const abandonedAuthority = coordinator.commands.beginPdfPick(new AbortController().signal);
    await failAbandonedPick(coordinator, abandonedAuthority);

    await expect(coordinator.commands.recoverPrivacyCleanup()).resolves.toBe(true);

    expect(cleanupRequest).toHaveBeenCalledTimes(2);
    expect(cleanupAbandoned).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toMatchObject({
      privacyReadiness: 'ready',
      cleanupPending: false,
    });
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

  it.each(['background', 'inactive'] as const)(
    '%s invalidates a pending source receipt and active foreground does not revive it',
    async lifecycle => {
      const { coordinator } = harness();
      await coordinator.initialize();

      const staleSelection = coordinator.commands.selectSource(textSource('stale private resume'));
      expect(coordinator.getState().mutation).toBe('selecting');
      const transition = coordinator.handleAppState(lifecycle);
      const [staleReceipt] = await Promise.all([staleSelection, transition]);
      await coordinator.handleAppState('active');

      expect(staleReceipt).toEqual({ committed: false });
      expect(coordinator.getState()).toMatchObject({ source: null, lifecycleEpoch: 1 });
      await expect(coordinator.commands.selectSource(textSource('new foreground resume')))
        .resolves.toMatchObject({ committed: true });
    },
  );

  it.each(['background', 'inactive'] as const)(
    '%s invalidates a pending job receipt and active foreground does not revive it',
    async lifecycle => {
      const { coordinator } = await readyHarness();

      const staleJob = coordinator.commands.setJobDescription('stale private job');
      expect(coordinator.getState().mutation).toBe('editing');
      const transition = coordinator.handleAppState(lifecycle);
      const [staleReceipt] = await Promise.all([staleJob, transition]);
      await coordinator.handleAppState('active');

      expect(staleReceipt).toEqual({ committed: false });
      expect(coordinator.getState()).toMatchObject({ source: null, lifecycleEpoch: 1 });
      await coordinator.commands.selectSource(textSource('new foreground resume'));
      await expect(coordinator.commands.setJobDescription('new foreground job'))
        .resolves.toMatchObject({ committed: true });
    },
  );

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

  it('returns a failed job receipt when reset supersedes the edit transaction', async () => {
    const { coordinator } = await readyHarness();

    const staleJob = coordinator.commands.setJobDescription('stale private job');
    const reset = coordinator.commands.reset();

    await expect(staleJob).resolves.toEqual({ committed: false });
    await reset;
    expect(coordinator.getState()).toMatchObject({ source: null, jobDescription: '' });
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
      .resolves.toEqual({ committed: false });
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

describe('review fixes: registry lease epochs', () => {
  it('snapshots the opaque PDF lease and uses it for terminal cleanup', async () => {
    const cleanupRequest = jest.fn(async (_requestId: string, lease?: symbol) =>
      lease === LEASE_A
        ? { attempted: 1, deleted: 1, failed: 0, refused: 0 }
        : { attempted: 0, deleted: 0, failed: 0, refused: 1 },
    );
    const ownership = leasedPdfOwnership();
    const { coordinator } = harness({
      pdfOwnership: ownership,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();
    const callerSource = leasedPdfSource() as unknown as { lease: symbol } & ResumeSource;
    await coordinator.commands.selectSource(callerSource);
    const storedSource = coordinator.getState().source;
    expect(storedSource).toMatchObject({ kind: 'pdf', lease: LEASE_A });
    expect(JSON.stringify(storedSource)).not.toContain('lease');
    expect(String(storedSource?.kind === 'pdf' ? storedSource.lease : null)).toBe('Symbol()');
    callerSource.lease = LEASE_B;

    await coordinator.commands.reset();

    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(coordinator.getState()).toMatchObject({ status: 'idle', source: null });
  });

  it('keeps timeout, reset, and dispose cleanup bound to stale A after B becomes current', async () => {
    jest.useFakeTimers();
    try {
      const lateCleanup = deferred<CleanupReceipt>();
      let currentLease: symbol | null = LEASE_A;
      const deletedLeases: symbol[] = [];
      const cleanupRequest = jest.fn((
        _requestId: string,
        lease?: symbol,
      ): Promise<CleanupReceipt> => {
        if (cleanupRequest.mock.calls.length === 1) {
          return lateCleanup.promise.then(receipt => {
            if (currentLease !== lease) {
              return { attempted: 0, deleted: 0, failed: 0, refused: 1 };
            }
            if (receipt.deleted === 1) {
              deletedLeases.push(lease);
              currentLease = null;
            }
            return receipt;
          });
        }
        if (currentLease !== lease) {
          return Promise.resolve({ attempted: 0, deleted: 0, failed: 0, refused: 1 });
        }
        deletedLeases.push(lease);
        currentLease = null;
        return Promise.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
      });
      const { coordinator } = harness({
        api: { analyze: jest.fn(async () => result(RESULT_A, 'pdf')) },
        pdfOwnership: leasedPdfOwnership(),
        tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
        cleanupTimeoutMs: 25,
      });
      await coordinator.initialize();
      await coordinator.commands.selectSource(leasedPdfSource());

      const analysis = coordinator.commands.analyze();
      await jest.advanceTimersByTimeAsync(25);
      await analysis;
      currentLease = LEASE_B;
      await coordinator.commands.reset();
      await coordinator.dispose();
      lateCleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
      await flushPromises();

      expect(cleanupRequest.mock.calls).toEqual([
        [REQUEST_A, LEASE_A],
        [REQUEST_A, LEASE_A],
        [REQUEST_A, LEASE_A],
      ]);
      expect(deletedLeases).toEqual([]);
      expect(currentLease).toBe(LEASE_B);
    } finally {
      jest.useRealTimers();
    }
  });

  it('strips the in-memory lease from the exact ResumeApi PDF request', async () => {
    const { api, coordinator } = harness({ pdfOwnership: leasedPdfOwnership() });
    await coordinator.initialize();
    await coordinator.commands.selectSource(leasedPdfSource());

    await coordinator.commands.analyze();

    expect(api.analyze.mock.calls[0]?.[0]).toEqual({
      source: {
        kind: 'pdf',
        uri: leasedPdfSource().uri,
        name: 'resume.pdf',
        mimeType: 'application/pdf',
        size: 1_024,
      },
      jobDescription: undefined,
      consentVersion: CONSENT_VERSION,
    });
    const sent = api.analyze.mock.calls[0]?.[0] as { source: unknown };
    expect(Object.prototype.hasOwnProperty.call(
      sent.source,
      'lease',
    )).toBe(false);
  });

  it.each([
    ['missing lease', {
      requestId: REQUEST_A,
      uri: pdfSource().uri,
      exists: true,
      size: 1_024,
    }],
    ['wrong lease', {
      requestId: REQUEST_A,
      uri: pdfSource().uri,
      lease: LEASE_B,
      exists: true,
      size: 1_024,
    }],
    ['extra field', {
      requestId: REQUEST_A,
      uri: pdfSource().uri,
      lease: LEASE_A,
      exists: true,
      size: 1_024,
      unexpected: true,
    }],
  ] as const)('rejects a live inspection with %s and cleans only its exact lease', async (_name, inspection) => {
    const cleanupRequest = jest.fn(async () => ({
      attempted: 1,
      deleted: 1,
      failed: 0,
      refused: 0,
    }));
    const ownership = {
      assertOwnedFileUri: jest.fn((uri: unknown) => ({ requestId: REQUEST_A, uri: String(uri) })),
      inspectOwnedFileUri: jest.fn(async () => inspection),
    };
    const { api, coordinator } = harness({
      pdfOwnership: ownership as never,
      tempFiles: { cleanupAbandoned: jest.fn(async () => CLEAN), cleanupRequest },
    });
    await coordinator.initialize();

    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: null,
      error: { category: 'validation' },
    });
  });
});

describe('PDF terminal cleanup', () => {
  it('translates only the generated owned URI, actual size, fixed MIME, and generic filename', async () => {
    const { api, coordinator } = harness();
    await coordinator.initialize();
    await coordinator.commands.selectSource(pdfSource());
    await coordinator.commands.analyze();

    expect(api.analyze.mock.calls[0][0]).toEqual({
      source: {
        kind: 'pdf',
        uri: pdfSource().uri,
        size: 1_024,
        mimeType: 'application/pdf',
        name: 'resume.pdf',
      },
      jobDescription: undefined,
      consentVersion: CONSENT_VERSION,
    });
  });

  it('strictly rejects and cleans a PDF source carrying provider metadata', async () => {
    const { api, coordinator, tempFiles } = harness();
    await coordinator.initialize();
    await coordinator.commands.selectSource({
      ...pdfSource(),
      providerFilename: 'Private Person - Staff Resume.pdf',
    } as unknown as ResumeSource);
    await coordinator.commands.analyze();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(JSON.stringify(coordinator.getState())).not.toContain('Private Person');
    expect(coordinator.getState()).toMatchObject({
      status: 'failed',
      source: null,
      error: { category: 'validation' },
    });
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

    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
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
    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
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

    expect(tempFiles.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
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

    const edit = await coordinator.commands.setJobDescription('updated private job draft');

    expect(cleanupRequest).toHaveBeenCalled();
    expect(edit).toEqual({ committed: false });
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
    const [firstReceipt, lastReceipt] = await Promise.all([firstReplacement, lastReplacement]);

    expect(coordinator.getState()).toMatchObject({ source: textSource('latest') });
    expect(firstReceipt).toEqual({ committed: false });
    expect(lastReceipt).toEqual({ committed: true, sourceIdentity: null, generation: 3 });
  });
});

describe('disposal and sensitive-data boundary', () => {
  it('never logs an opaque PDF lease during selection or terminal cleanup', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnLog = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoLog = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const { coordinator } = harness({ pdfOwnership: leasedPdfOwnership() });
      await coordinator.initialize();
      await coordinator.commands.selectSource(leasedPdfSource());
      await coordinator.commands.reset();

      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
      expect(infoLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
      infoLog.mockRestore();
    }
  });

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
