import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { AnalysisCoordinator } from '../src/analysis/analysisCoordinator';
import {
  AppControllerRoot,
  type AppControllerValue,
  type AppServices,
  useAppController,
} from '../src/controllers/AppController';
import type { PickedPdfForDisplay } from '../src/documents/documentSource';

let mockAnalysisValue: AppControllerValue['analysis'];

jest.mock('../src/analysis/AnalysisProvider', () => ({
  useAnalysis: () => mockAnalysisValue,
}));
jest.mock('../src/storage/DataProvider', () => ({
  useReportData: () => ({ status: 'loading', repository: null }),
}));

const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEASE_A = Symbol('lease-a');
const LEASE_B = Symbol('lease-b');
const CLEAN = { attempted: 1, deleted: 1, failed: 0, refused: 0 } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

function pickedPdf(requestId: string, lease: symbol, displayName: string): PickedPdfForDisplay {
  return {
    source: {
      kind: 'pdf',
      requestId,
      uri: `file:///app/cache/resume-ai-v1/${requestId}/11111111-1111-4111-8111-111111111111.pdf`,
      size: 100,
      lease,
    },
    displayName,
  };
}

const PDF_A = pickedPdf(REQUEST_A, LEASE_A, 'Private A.pdf');
const PDF_B = pickedPdf(REQUEST_B, LEASE_B, 'Private B.pdf');
const PDF_B_COLLISION = pickedPdf(REQUEST_A, LEASE_B, 'Private B.pdf');

function Probe({ capture }: Readonly<{ capture(value: AppControllerValue): void }>) {
  capture(useAppController());
  return null;
}

async function controllerHarness(options: Readonly<{
  pickPdfForDisplay: jest.Mock<Promise<PickedPdfForDisplay | null>, []>;
  cleanupRequest?: jest.Mock;
  cleanupTimeoutMs?: number;
  inspectOwnedFileUri?: jest.Mock;
}>) {
  const cleanupRequest = options.cleanupRequest ?? jest.fn(async () => CLEAN);
  const coordinator = new AnalysisCoordinator({
    api: { analyze: jest.fn() },
    consentStore: {
      hasCurrentConsent: jest.fn(async () => false),
      grant: jest.fn(async () => undefined),
    },
    tempFiles: {
      cleanupAbandoned: jest.fn(async () => ({ attempted: 0, deleted: 0, failed: 0, refused: 0 })),
      cleanupRequest,
    },
    pdfOwnership: {
      assertOwnedFileUri(uri: unknown) {
        if (typeof uri !== 'string') throw new Error('invalid');
        const requestId = uri.includes(REQUEST_A) ? REQUEST_A : uri.includes(REQUEST_B) ? REQUEST_B : '';
        if (requestId.length === 0) throw new Error('invalid');
        return { requestId, uri };
      },
      async inspectOwnedFileUri(uri, requestId, lease) {
        if (typeof uri !== 'string') throw new Error('invalid');
        if (options.inspectOwnedFileUri !== undefined) {
          return options.inspectOwnedFileUri(uri, requestId, lease);
        }
        return { requestId, uri, lease, exists: true, size: 100 };
      },
    },
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 100,
  });
  await coordinator.initialize();
  const services: AppServices = {
    documents: { pickPdfForDisplay: options.pickPdfForDisplay },
    consent: { clear: jest.fn(async () => undefined) },
    cache: { cleanupAbandonedDetailed: jest.fn(async () => ({
      attempted: 0,
      deleted: 0,
      failed: 0,
      refused: 0,
      live: 0,
      deletedFiles: 0,
    })) },
    shareText: jest.fn(async () => undefined),
    openSupport: jest.fn(async () => undefined),
    serviceAvailable: true,
    appVersion: '1.0.0',
  };
  let value: AppControllerValue | null = null;
  mockAnalysisValue = { state: coordinator.getState(), commands: coordinator.commands };
  const view = await render(
    <AppControllerRoot services={services}>
      <Probe capture={next => { value = next; }} />
    </AppControllerRoot>,
  );
  await waitFor(() => expect(value).not.toBeNull());
  return {
    coordinator,
    cleanupRequest,
    view,
    async close() {
      await view.unmount();
      await coordinator.dispose();
    },
    get value(): AppControllerValue { return value as unknown as AppControllerValue; },
  };
}

describe('native picker operation authority', () => {
  it.each(['background', 'inactive'] as const)(
    '%s rejects and exact-lease cleans a PDF staged after the picker lost lifecycle authority',
    async lifecycle => {
      const first = deferred<PickedPdfForDisplay | null>();
      const pickPdfForDisplay = jest.fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce(PDF_B);
      const harness = await controllerHarness({ pickPdfForDisplay });
      const firstSignal = new AbortController();
      const stalePick = harness.value.actions.pickPdfForDisplay(firstSignal.signal);
      await waitFor(() => expect(pickPdfForDisplay).toHaveBeenCalledTimes(1));

      await act(async () => { await harness.coordinator.handleAppState(lifecycle); });
      first.resolve(PDF_A);
      await expect(stalePick).resolves.toBeNull();
      expect(harness.coordinator.getState()).toMatchObject({ source: null, lifecycleEpoch: 1 });
      expect(harness.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);

      await act(async () => { await harness.coordinator.handleAppState('active'); });
      expect(harness.coordinator.getState().source).toBeNull();
      const foreground = await harness.value.actions.pickPdfForDisplay(new AbortController().signal);
      expect(foreground).toMatchObject({ sourceIdentity: LEASE_B, displayName: 'Private B.pdf' });
      expect(harness.coordinator.getState().source).toMatchObject({ requestId: REQUEST_B, lease: LEASE_B });
      await harness.close();
    },
  );

  it('uses the caller AbortSignal to revoke a native pick before its staged result resolves', async () => {
    const pending = deferred<PickedPdfForDisplay | null>();
    const harness = await controllerHarness({ pickPdfForDisplay: jest.fn(() => pending.promise) });
    const controller = new AbortController();
    const pick = harness.value.actions.pickPdfForDisplay(controller.signal);
    controller.abort();
    pending.resolve(PDF_A);

    await expect(pick).resolves.toBeNull();
    expect(harness.coordinator.getState().source).toBeNull();
    expect(harness.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    await harness.close();
  });

  it.each(['A then B', 'B then A'] as const)(
    'only the latest overlapping native pick commits when resolutions arrive %s',
    async order => {
      const pendingA = deferred<PickedPdfForDisplay | null>();
      const pendingB = deferred<PickedPdfForDisplay | null>();
      const pickPdfForDisplay = jest.fn()
        .mockImplementationOnce(() => pendingA.promise)
        .mockImplementationOnce(() => pendingB.promise);
      const harness = await controllerHarness({ pickPdfForDisplay });
      const pickA = harness.value.actions.pickPdfForDisplay(new AbortController().signal);
      const pickB = harness.value.actions.pickPdfForDisplay(new AbortController().signal);

      let resultA;
      let resultB;
      if (order === 'A then B') {
        pendingA.resolve(PDF_A);
        resultA = await pickA;
        pendingB.resolve(PDF_B);
        resultB = await pickB;
      } else {
        pendingB.resolve(PDF_B);
        resultB = await pickB;
        pendingA.resolve(PDF_A);
        resultA = await pickA;
      }

      expect(resultA).toBeNull();
      expect(resultB).toMatchObject({ sourceIdentity: LEASE_B, displayName: 'Private B.pdf' });
      expect(harness.coordinator.getState().source).toMatchObject({ requestId: REQUEST_B, lease: LEASE_B });
      expect(harness.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
      expect(harness.cleanupRequest).not.toHaveBeenCalledWith(REQUEST_B, LEASE_B);
      await harness.close();
    },
  );

  it('a replacement pick supersedes an older adoption already awaiting ownership inspection', async () => {
    const inspectionA = deferred<{
      requestId: string;
      uri: string;
      lease: symbol;
      exists: boolean;
      size: number;
    }>();
    const pendingB = deferred<PickedPdfForDisplay | null>();
    const pickPdfForDisplay = jest.fn()
      .mockResolvedValueOnce(PDF_A)
      .mockImplementationOnce(() => pendingB.promise);
    const inspectOwnedFileUri = jest.fn((uri: string, requestId: string, lease: symbol) =>
      requestId === REQUEST_A
        ? inspectionA.promise
        : Promise.resolve({ requestId, uri, lease, exists: true, size: 100 }),
    );
    const harness = await controllerHarness({ pickPdfForDisplay, inspectOwnedFileUri });
    const pickA = harness.value.actions.pickPdfForDisplay(new AbortController().signal);
    await waitFor(() => expect(inspectOwnedFileUri).toHaveBeenCalledTimes(1));

    const pickB = harness.value.actions.pickPdfForDisplay(new AbortController().signal);
    inspectionA.resolve({
      requestId: REQUEST_A,
      uri: PDF_A.source.uri,
      lease: LEASE_A,
      exists: true,
      size: 100,
    });
    await expect(pickA).resolves.toBeNull();
    pendingB.resolve(PDF_B);

    await expect(pickB).resolves.toMatchObject({ sourceIdentity: LEASE_B });
    expect(harness.coordinator.getState().source).toMatchObject({ requestId: REQUEST_B, lease: LEASE_B });
    expect(harness.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(harness.cleanupRequest).not.toHaveBeenCalledWith(REQUEST_B, LEASE_B);
    await harness.close();
  });

  it('a stale colliding request cleans only its old lease and cannot revoke the latest lease', async () => {
    const pendingA = deferred<PickedPdfForDisplay | null>();
    const pickPdfForDisplay = jest.fn()
      .mockImplementationOnce(() => pendingA.promise)
      .mockResolvedValueOnce(PDF_B_COLLISION);
    const harness = await controllerHarness({ pickPdfForDisplay });
    const pickA = harness.value.actions.pickPdfForDisplay(new AbortController().signal);
    const pickB = harness.value.actions.pickPdfForDisplay(new AbortController().signal);
    await expect(pickB).resolves.toMatchObject({ sourceIdentity: LEASE_B });

    pendingA.resolve(PDF_A);

    await expect(pickA).resolves.toBeNull();
    expect(harness.coordinator.getState().source).toMatchObject({ requestId: REQUEST_A, lease: LEASE_B });
    expect(harness.cleanupRequest).toHaveBeenCalledWith(REQUEST_A, LEASE_A);
    expect(harness.cleanupRequest).not.toHaveBeenCalledWith(REQUEST_A, LEASE_B);
    await harness.close();
  });

  it.each([
    ['failure', jest.fn(async () => ({ attempted: 1, deleted: 0, failed: 1, refused: 0 }))],
    ['timeout', jest.fn(() => new Promise(() => undefined))],
  ] as const)('a stale staged-PDF cleanup %s blocks privacy and cannot be hidden', async (_case, cleanupRequest) => {
    const pending = deferred<PickedPdfForDisplay | null>();
    const harness = await controllerHarness({
      pickPdfForDisplay: jest.fn(() => pending.promise),
      cleanupRequest,
      cleanupTimeoutMs: 20,
    });
    const controller = new AbortController();
    const pick = harness.value.actions.pickPdfForDisplay(controller.signal);
    controller.abort();
    pending.resolve(PDF_A);

    await expect(pick).resolves.toBeNull();
    expect(harness.coordinator.getState()).toMatchObject({
      status: 'failed',
      privacyReadiness: 'blocked',
      source: null,
      cleanupPending: true,
      error: { category: 'privacy' },
    });
    await harness.coordinator.handleAppState('active');
    expect(harness.coordinator.getState().privacyReadiness).toBe('blocked');
    await harness.close();
  });

  it('a later reset or source intent cannot erase a picker cleanup privacy block', async () => {
    const pending = deferred<PickedPdfForDisplay | null>();
    const cleanupRequest = jest.fn()
      .mockResolvedValueOnce({ attempted: 1, deleted: 0, failed: 1, refused: 0 })
      .mockResolvedValue(CLEAN);
    const harness = await controllerHarness({
      pickPdfForDisplay: jest.fn(() => pending.promise),
      cleanupRequest,
    });
    const controller = new AbortController();
    const pick = harness.value.actions.pickPdfForDisplay(controller.signal);
    controller.abort();
    pending.resolve(PDF_A);
    await pick;

    await harness.value.analysis.commands.reset();
    await expect(harness.value.analysis.commands.selectSource({ kind: 'text', text: 'later resume' }))
      .resolves.toEqual({ committed: false });

    expect(cleanupRequest).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getState()).toMatchObject({
      status: 'failed',
      privacyReadiness: 'blocked',
      source: null,
      cleanupPending: true,
      error: {
        category: 'privacy',
        message: 'Temporary resume data could not be removed safely.',
      },
    });
    await harness.close();
  });

  it('only explicit exact-lease recovery clears a stale-picker privacy block', async () => {
    const pending = deferred<PickedPdfForDisplay | null>();
    const cleanupRequest = jest.fn()
      .mockResolvedValueOnce({ attempted: 1, deleted: 0, failed: 1, refused: 0 })
      .mockResolvedValueOnce(CLEAN);
    const harness = await controllerHarness({
      pickPdfForDisplay: jest.fn(() => pending.promise),
      cleanupRequest,
    });
    const controller = new AbortController();
    const pick = harness.value.actions.pickPdfForDisplay(controller.signal);
    controller.abort();
    pending.resolve(PDF_A);
    await pick;

    const recover = (harness.value.analysis.commands as unknown as {
      recoverPrivacyCleanup?: () => Promise<boolean>;
    }).recoverPrivacyCleanup;
    const recovered = await recover?.();

    expect(recovered).toBe(true);
    expect(cleanupRequest.mock.calls).toEqual([
      [REQUEST_A, LEASE_A],
      [REQUEST_A, LEASE_A],
    ]);
    expect(harness.coordinator.getState()).toMatchObject({
      status: 'idle',
      privacyReadiness: 'ready',
      source: null,
      error: null,
      cleanupPending: false,
    });
    await harness.close();
  });

  it('treats native picker cancellation as harmless when no file was staged', async () => {
    const cleanupRequest = jest.fn(async () => CLEAN);
    const harness = await controllerHarness({
      pickPdfForDisplay: jest.fn(async () => null),
      cleanupRequest,
    });

    await expect(harness.value.actions.pickPdfForDisplay(new AbortController().signal))
      .resolves.toBeNull();
    expect(harness.coordinator.getState().source).toBeNull();
    expect(cleanupRequest).not.toHaveBeenCalled();
    await harness.close();
  });
});
