import type { AnalyzeRequest } from '../api/resumeApi';
import { CONSENT_VERSION } from '../domain/consent';
import type { AnalysisResponse } from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';
import {
  codePointLength,
  isNonBlankPythonText,
  MAX_JOB_DESCRIPTION_CODE_POINTS,
  MAX_PDF_BYTES,
  MAX_RESUME_CODE_POINTS,
  trimPythonWhitespace,
} from '../domain/limits';
import type { ResumeSource } from '../documents/documentSource';
import type { CleanupReceipt, TempFileLease } from '../documents/tempFileRegistry';
import {
  analysisReducer,
  createInitialAnalysisState,
  type AnalysisEvent,
  type AnalysisMutation,
  type AnalysisState,
  type PublicAnalysisError,
} from './analysisReducer';

export type AnalysisApiPort = Readonly<{
  analyze(request: AnalyzeRequest, signal: AbortSignal): Promise<AnalysisResponse>;
}>;

export type AnalysisConsentStorePort = Readonly<{
  hasCurrentConsent(): Promise<boolean>;
  grant(): Promise<void>;
}>;

export type AnalysisTempFilesPort = Readonly<{
  cleanupAbandoned(): Promise<CleanupReceipt>;
  cleanupRequest(requestId: string, lease: TempFileLease): Promise<CleanupReceipt>;
}>;

export type PdfOwnershipPort = Readonly<{
  assertOwnedFileUri(uri: unknown): { requestId: string; uri: string };
  inspectOwnedFileUri(
    uri: unknown,
    requestId: string,
    lease: TempFileLease,
  ): Promise<{
    requestId: string;
    uri: string;
    lease: TempFileLease;
    exists: boolean;
    size: number;
  }>;
}>;

export type AnalysisCoordinatorOptions = Readonly<{
  api: AnalysisApiPort;
  consentStore: AnalysisConsentStorePort;
  tempFiles: AnalysisTempFilesPort;
  pdfOwnership: PdfOwnershipPort;
  cleanupTimeoutMs?: number;
}>;

export type AnalysisCommands = Readonly<{
  selectSource(source: ResumeSource): Promise<SourceSelectionReceipt>;
  setJobDescription(value: string): Promise<void>;
  analyze(): Promise<void>;
  grantConsent(): Promise<void>;
  declineConsent(): Promise<void>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
}>;

export type SourceSelectionReceipt =
  | Readonly<{ committed: false }>
  | Readonly<{ committed: true; sourceIdentity: symbol | null; generation: number }>;

type ActivationPhase = 'consentRead' | 'consentWrite' | 'network';

type Activation = {
  readonly id: number;
  readonly generation: number;
  readonly sourceRevision: number;
  readonly source: ResumeSource;
  readonly claim: PdfClaim | null;
  readonly controller: AbortController;
  phase: ActivationPhase;
  sourceConsumed: boolean;
  promise: Promise<void>;
};

type ConsentContinuation = Readonly<{
  generation: number;
  sourceRevision: number;
}>;

type PdfClaim = Readonly<{
  requestId: string;
  uri: string;
  lease: TempFileLease;
  epoch: number;
}>;

type PreparedSource = Readonly<{
  source: ResumeSource | null;
  claimedRequestId: string | null;
  newlyClaimed: boolean;
  claim: PdfClaim | null;
}>;

type MutationContext = Readonly<{
  generation: number;
  previousActivation: Activation | null;
}>;

class CoordinatorAbort extends Error {}
class CleanupTimeout extends Error {}

const PUBLIC_MESSAGES = Object.freeze({
  privacy: 'Temporary resume data could not be removed safely.',
  consent_storage: 'Consent could not be saved securely.',
  validation: 'The selected material is not supported.',
  network: 'The service could not be reached.',
});

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function privacyError(): PublicAnalysisError {
  return { category: 'privacy', message: PUBLIC_MESSAGES.privacy, retryable: false };
}

function consentStorageError(): PublicAnalysisError {
  return {
    category: 'consent_storage',
    message: PUBLIC_MESSAGES.consent_storage,
    retryable: false,
  };
}

function validationError(): PublicAnalysisError {
  return { category: 'validation', message: PUBLIC_MESSAGES.validation, retryable: false };
}

function publicApiError(error: unknown): PublicAnalysisError {
  if (error instanceof ResumeApiError) {
    return {
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  return { category: 'network', message: PUBLIC_MESSAGES.network, retryable: false };
}

function isVerifiedCleanupReceipt(value: unknown): value is CleanupReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).length !== 4 ||
    !['attempted', 'deleted', 'failed', 'refused'].every(key =>
      Number.isSafeInteger(receipt[key]) && (receipt[key] as number) >= 0,
    )
  ) return false;
  return receipt.failed === 0 && receipt.refused === 0 && receipt.attempted === receipt.deleted;
}

function isStaleLeaseReceipt(value: unknown): value is CleanupReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 4 &&
    receipt.attempted === 0 &&
    receipt.deleted === 0 &&
    receipt.failed === 0 &&
    receipt.refused === 1;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' &&
    !value.includes('\0') &&
    isNonBlankPythonText(value) &&
    codePointLength(value) <= MAX_RESUME_CODE_POINTS;
}

function snapshotNonPdfSource(source: unknown): ResumeSource | null {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;
  const candidate = source as Record<string, unknown>;
  if (candidate.kind === 'text' && validText(candidate.text)) {
    return Object.freeze({ kind: 'text', text: candidate.text });
  }
  if (
    candidate.kind === 'vision_text' &&
    candidate.reviewed === true &&
    validText(candidate.text) &&
    (candidate.pageCount === undefined ||
      (Number.isSafeInteger(candidate.pageCount) &&
        (candidate.pageCount as number) > 0 &&
        (candidate.pageCount as number) <= 10))
  ) {
    return Object.freeze({
      kind: 'vision_text',
      text: candidate.text,
      reviewed: true,
      ...(candidate.pageCount === undefined ? {} : { pageCount: candidate.pageCount as number }),
    });
  }
  return null;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CoordinatorAbort());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new CoordinatorAbort());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

export class AnalysisCoordinator {
  private state: AnalysisState = createInitialAnalysisState();
  private readonly listeners = new Set<() => void>();
  private readonly api: AnalysisApiPort;
  private readonly consentStore: AnalysisConsentStorePort;
  private readonly tempFiles: AnalysisTempFilesPort;
  private readonly pdfOwnership: PdfOwnershipPort;
  private readonly cleanupTimeoutMs: number;
  private generation = 0;
  private sourceRevision = 0;
  private nextActivation = 0;
  private active: Activation | null = null;
  private consentContinuation: ConsentContinuation | null = null;
  private initialization: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private mounted = true;
  private nextPdfClaimEpoch = 0;
  private committedPdfClaim: PdfClaim | null = null;
  private readonly pdfClaims = new Map<string, PdfClaim>();
  private readonly ownedPdfRequestIds = new Set<string>();
  private readonly cleanupFailures = new Set<TempFileLease>();
  private readonly cleanupOperations = new Map<TempFileLease, Promise<boolean>>();
  private readonly preReadyPdfCleanupOperations = new Set<Promise<boolean>>();

  readonly commands: AnalysisCommands = Object.freeze({
    selectSource: (source: ResumeSource) => this.selectSource(source),
    setJobDescription: (value: string) => this.setJobDescription(value),
    analyze: () => this.analyze(),
    grantConsent: () => this.grantConsent(),
    declineConsent: () => this.declineConsent(),
    cancel: () => this.cancel(),
    reset: () => this.reset(),
  });

  constructor(options: AnalysisCoordinatorOptions) {
    this.api = options.api;
    this.consentStore = options.consentStore;
    this.tempFiles = options.tempFiles;
    this.pdfOwnership = options.pdfOwnership;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.cleanupTimeoutMs) ||
      this.cleanupTimeoutMs <= 0 ||
      this.cleanupTimeoutMs > 10_000
    ) throw new TypeError('A bounded cleanup timeout is required.');
  }

  getState = (): AnalysisState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  initialize(): Promise<void> {
    if (this.initialization !== null) return this.initialization;
    this.initialization = this.performInitialization();
    return this.initialization;
  }

  private async performInitialization(): Promise<void> {
    let ready = false;
    try {
      const receipt = await this.boundedCleanup(() => this.tempFiles.cleanupAbandoned());
      ready = isVerifiedCleanupReceipt(receipt);
    } catch {
      ready = false;
    }
    while (this.preReadyPdfCleanupOperations.size > 0) {
      const results = await Promise.all([...this.preReadyPdfCleanupOperations]);
      if (results.some(clean => !clean)) ready = false;
    }
    if (this.cleanupFailures.size > 0) ready = false;
    if (!this.mounted) return;
    this.dispatch(ready
      ? { type: 'initializationReady' }
      : { type: 'initializationFailed', error: privacyError() });
  }

  private apply(event: AnalysisEvent): boolean {
    if (!this.mounted) return false;
    const next = analysisReducer(this.state, event);
    if (next === this.state) return false;
    this.state = next;
    return true;
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Subscriber failures are isolated and never receive private causes.
      }
    }
  }

  private dispatch(event: AnalysisEvent): void {
    if (this.apply(event)) this.notifyListeners();
  }

  private enqueueMutation(
    mutation: Exclude<AnalysisMutation, 'none'>,
    work: (context: MutationContext) => Promise<void>,
  ): Promise<void> {
    if (!this.mounted) return Promise.resolve();
    const priorMutation = this.mutationTail;
    const previousActivation = this.active;
    const generation = ++this.generation;
    this.sourceRevision += 1;
    this.consentContinuation = null;
    previousActivation?.controller.abort();

    const changed = this.apply({ type: 'mutationStarted', generation, mutation });
    const operation = (async () => {
      await priorMutation;
      if (previousActivation !== null) await previousActivation.promise;
      try {
        await work({ generation, previousActivation });
      } catch {
        if (this.isCurrentMutation(generation)) {
          this.dispatch({
            type: 'analysisFailed',
            generation,
            error: validationError(),
            consumeSource: false,
            cleanupPending: this.cleanupFailures.size > 0,
          });
        }
      }
    })();
    const safeOperation = operation.catch(() => undefined);
    this.mutationTail = safeOperation;
    if (changed) this.notifyListeners();
    return safeOperation;
  }

  private isCurrent(generation: number): boolean {
    return this.mounted && generation === this.generation;
  }

  private isCurrentMutation(generation: number): boolean {
    return this.isCurrent(generation) && this.state.mutation !== 'none';
  }

  private activationIsCurrent(activation: Activation): boolean {
    return this.mounted &&
      this.active === activation &&
      activation.generation === this.generation &&
      activation.sourceRevision === this.sourceRevision &&
      this.state.mutation === 'none';
  }

  private isPdfClaimCurrent(claim: PdfClaim): boolean {
    const current = this.pdfClaims.get(claim.requestId);
    return current !== undefined &&
      current.epoch === claim.epoch &&
      current.uri === claim.uri &&
      current.lease === claim.lease &&
      this.ownedPdfRequestIds.has(claim.requestId);
  }

  private prepareIncomingSource(source: unknown): PreparedSource {
    if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
      const candidate = source as Record<string, unknown>;
      if (candidate.kind === 'pdf') {
        if (typeof candidate.lease !== 'symbol') {
          return { source: null, claimedRequestId: null, newlyClaimed: false, claim: null };
        }
        let asserted: { requestId: string; uri: string };
        try {
          asserted = this.pdfOwnership.assertOwnedFileUri(candidate.uri);
        } catch {
          return { source: null, claimedRequestId: null, newlyClaimed: false, claim: null };
        }
        if (
          asserted === null ||
          typeof asserted !== 'object' ||
          !hasExactKeys(asserted, ['requestId', 'uri']) ||
          typeof asserted.requestId !== 'string' ||
          !REQUEST_ID_PATTERN.test(asserted.requestId) ||
          typeof asserted.uri !== 'string'
        ) return { source: null, claimedRequestId: null, newlyClaimed: false, claim: null };

        if (this.ownedPdfRequestIds.has(asserted.requestId)) {
          return { source: null, claimedRequestId: null, newlyClaimed: false, claim: null };
        }
        const claim = Object.freeze({
          requestId: asserted.requestId,
          uri: asserted.uri,
          lease: candidate.lease,
          epoch: ++this.nextPdfClaimEpoch,
        });
        this.ownedPdfRequestIds.add(asserted.requestId);
        this.pdfClaims.set(asserted.requestId, claim);
        const sizeIsValid = typeof candidate.size === 'number' &&
          Number.isSafeInteger(candidate.size) &&
          candidate.size > 0 &&
          candidate.size <= MAX_PDF_BYTES;
        if (
          !hasExactKeys(candidate, ['kind', 'requestId', 'uri', 'size', 'lease']) ||
          candidate.requestId !== asserted.requestId ||
          !sizeIsValid
        ) {
          return {
            source: null,
            claimedRequestId: asserted.requestId,
            newlyClaimed: true,
            claim,
          };
        }
        return {
          source: Object.freeze({
            kind: 'pdf',
            requestId: asserted.requestId,
            uri: asserted.uri,
            size: candidate.size as number,
            lease: candidate.lease,
          }),
          claimedRequestId: asserted.requestId,
          newlyClaimed: true,
          claim,
        };
      }
    }
    return {
      source: snapshotNonPdfSource(source),
      claimedRequestId: null,
      newlyClaimed: false,
      claim: null,
    };
  }

  private async verifyLivePdfClaim(source: ResumeSource, claim: PdfClaim | null): Promise<boolean> {
    if (source.kind !== 'pdf' || claim === null || !this.isPdfClaimCurrent(claim)) return false;
    let inspected: Awaited<ReturnType<PdfOwnershipPort['inspectOwnedFileUri']>>;
    try {
      inspected = await this.pdfOwnership.inspectOwnedFileUri(
        claim.uri,
        claim.requestId,
        claim.lease,
      );
    } catch {
      return false;
    }
    return this.isPdfClaimCurrent(claim) &&
      inspected !== null &&
      typeof inspected === 'object' &&
      hasExactKeys(inspected, ['requestId', 'uri', 'lease', 'exists', 'size']) &&
      inspected.requestId === claim.requestId &&
      inspected.uri === claim.uri &&
      inspected.lease === claim.lease &&
      inspected.exists === true &&
      inspected.size === source.size;
  }

  private rejectPdfBeforePrivacyReady(prepared: PreparedSource): Promise<void> {
    if (prepared.claim === null || !prepared.newlyClaimed) return Promise.resolve();
    const cleanup = this.cleanupClaim(prepared.claim);
    this.preReadyPdfCleanupOperations.add(cleanup);
    void cleanup.finally(() => {
      this.preReadyPdfCleanupOperations.delete(cleanup);
    }).catch(() => undefined);
    return cleanup.then(clean => {
      if (!clean && this.mounted) {
        this.dispatch({ type: 'initializationFailed', error: privacyError() });
      }
    });
  }

  private async selectSource(input: ResumeSource): Promise<SourceSelectionReceipt> {
    const prepared = this.prepareIncomingSource(input);
    const isPdfAttempt = input !== null && typeof input === 'object' && input.kind === 'pdf';
    if (isPdfAttempt && this.state.privacyReadiness !== 'ready') {
      await this.rejectPdfBeforePrivacyReady(prepared);
      return { committed: false };
    }
    if (this.state.privacyReadiness === 'blocked') return { committed: false };
    if (!this.mounted) {
      if (prepared.claim !== null && prepared.newlyClaimed) await this.cleanupClaim(prepared.claim);
      return { committed: false };
    }
    const previousSource = this.state.source;
    const previousClaim = this.committedPdfClaim;
    let committed = false;
    let incomingReleased = false;
    const initialization = this.initialize();

    await this.enqueueMutation('selecting', async ({ generation }) => {
      const releaseIncoming = async (): Promise<boolean> => {
        if (
          incomingReleased ||
          prepared.claim === null ||
          !prepared.newlyClaimed
        ) return true;
        incomingReleased = true;
        return this.cleanupClaim(prepared.claim);
      };

      try {
        await initialization;
        if (!this.isCurrentMutation(generation) || this.state.privacyReadiness !== 'ready') return;

        const unrelatedClean = await this.cleanupUncommitted(prepared.claim);
        if (!this.isCurrentMutation(generation)) return;
        if (!unrelatedClean) {
          const incomingClean = await releaseIncoming();
          if (this.isCurrentMutation(generation)) {
            this.dispatch({
              type: 'analysisFailed',
              generation,
              error: privacyError(),
              consumeSource: false,
              cleanupPending: !incomingClean || this.cleanupFailures.size > 0,
            });
          }
          return;
        }

        let previousConsumed = false;
        if (previousSource?.kind === 'pdf') {
          previousConsumed = previousClaim !== null && await this.cleanupClaim(previousClaim);
          if (!this.isCurrentMutation(generation)) return;
          if (!previousConsumed) {
            const incomingClean = await releaseIncoming();
            if (this.isCurrentMutation(generation)) {
              this.dispatch({
                type: 'analysisFailed',
                generation,
                error: privacyError(),
                consumeSource: false,
                cleanupPending: !incomingClean || this.cleanupFailures.size > 0,
              });
            }
            return;
          }
        }

        if (prepared.source === null) {
          const incomingClean = await releaseIncoming();
          if (!this.isCurrentMutation(generation)) return;
          this.dispatch({
            type: 'analysisFailed',
            generation,
            error: incomingClean ? validationError() : privacyError(),
            consumeSource: previousSource?.kind !== 'pdf' || previousConsumed,
            cleanupPending: !incomingClean || this.cleanupFailures.size > 0,
          });
          return;
        }

        if (
          prepared.source.kind === 'pdf' &&
          !(await this.verifyLivePdfClaim(prepared.source, prepared.claim))
        ) {
          const incomingClean = await releaseIncoming();
          if (!this.isCurrentMutation(generation)) return;
          this.dispatch({
            type: 'analysisFailed',
            generation,
            error: incomingClean ? validationError() : privacyError(),
            consumeSource: previousSource?.kind !== 'pdf' || previousConsumed,
            cleanupPending: !incomingClean || this.cleanupFailures.size > 0,
          });
          return;
        }

        if (
          !this.isCurrentMutation(generation) ||
          (prepared.source.kind === 'pdf' &&
            (prepared.claim === null || !this.isPdfClaimCurrent(prepared.claim)))
        ) return;
        committed = true;
        if (prepared.source.kind === 'pdf') {
          this.committedPdfClaim = prepared.claim;
        } else {
          this.committedPdfClaim = null;
        }
        this.dispatch({ type: 'sourceReady', generation, source: prepared.source });
      } finally {
        if (!committed && !incomingReleased) {
          const cleaned = await releaseIncoming();
          if (!cleaned && this.isCurrentMutation(generation)) {
            this.dispatch({
              type: 'analysisFailed',
              generation,
              error: privacyError(),
              consumeSource: false,
              cleanupPending: true,
            });
          }
        }
      }
    });
    if (!committed || this.state.mutation !== 'none' || prepared.source === null) {
      return { committed: false };
    }
    const committedSource = this.state.source;
    if (prepared.source.kind === 'pdf') {
      return committedSource?.kind === 'pdf' &&
        committedSource.requestId === prepared.source.requestId &&
        committedSource.uri === prepared.source.uri &&
        committedSource.lease === prepared.source.lease
        ? { committed: true, sourceIdentity: prepared.source.lease, generation: this.state.generation }
        : { committed: false };
    }
    if (prepared.source.kind === 'text') {
      return committedSource?.kind === 'text' && committedSource.text === prepared.source.text
        ? { committed: true, sourceIdentity: null, generation: this.state.generation }
        : { committed: false };
    }
    return committedSource?.kind === 'vision_text' &&
      committedSource.text === prepared.source.text &&
      committedSource.reviewed === prepared.source.reviewed &&
      committedSource.pageCount === prepared.source.pageCount
      ? { committed: true, sourceIdentity: null, generation: this.state.generation }
      : { committed: false };
  }

  private setJobDescription(value: string): Promise<void> {
    if (!this.mounted) return Promise.resolve();
    const source = this.state.source;
    const sourceClaim = this.committedPdfClaim;
    const wasConsentRequired = this.state.status === 'consentRequired';
    const initialization = this.initialize();
    return this.enqueueMutation('editing', async ({ generation, previousActivation }) => {
      await initialization;
      if (!this.isCurrentMutation(generation) || this.state.privacyReadiness !== 'ready') return;
      if (!(await this.cleanupUncommitted())) {
        if (this.isCurrentMutation(generation)) this.dispatchPrivacyFailure(generation, false);
        return;
      }
      if (!this.isCurrentMutation(generation)) return;

      const validJob = typeof value === 'string' &&
        !value.includes('\0') &&
        codePointLength(value) <= MAX_JOB_DESCRIPTION_CODE_POINTS;
      let consumeSource = false;
      if (source?.kind === 'pdf') {
        const activationConsumed = previousActivation?.sourceConsumed === true;
        const leftPreNetwork = previousActivation?.phase === 'consentRead' ||
          previousActivation?.phase === 'consentWrite' ||
          wasConsentRequired;
        const deletionAlreadyProved = sourceClaim === null || !this.isPdfClaimCurrent(sourceClaim);
        const mustConsume = activationConsumed || leftPreNetwork || deletionAlreadyProved ||
          (sourceClaim !== null && this.cleanupFailures.has(sourceClaim.lease)) ||
          this.state.cleanupPending;
        if (mustConsume) {
          consumeSource = deletionAlreadyProved ||
            (sourceClaim !== null && await this.cleanupClaim(sourceClaim));
          if (!this.isCurrentMutation(generation)) return;
          if (!consumeSource) {
            this.dispatchPrivacyFailure(generation, false);
            return;
          }
        }
      }
      if (!validJob) {
        this.dispatch({
          type: 'analysisFailed',
          generation,
          error: validationError(),
          consumeSource,
          cleanupPending: this.cleanupFailures.size > 0,
        });
        return;
      }
      this.dispatch({
        type: 'jobUpdated',
        generation,
        jobDescription: value,
        consumeSource,
      });
    });
  }

  private newActivation(source: ResumeSource, phase: ActivationPhase): Activation {
    const claim = source.kind === 'pdf' &&
      this.committedPdfClaim !== null &&
      this.committedPdfClaim.requestId === source.requestId &&
      this.committedPdfClaim.uri === source.uri &&
      this.committedPdfClaim.lease === source.lease
      ? this.committedPdfClaim
      : null;
    const activation: Activation = {
      id: ++this.nextActivation,
      generation: this.generation,
      sourceRevision: this.sourceRevision,
      source,
      claim,
      controller: new AbortController(),
      phase,
      sourceConsumed: false,
      promise: Promise.resolve(),
    };
    this.active = activation;
    return activation;
  }

  private analyze(): Promise<void> {
    if (this.active !== null && this.activationIsCurrent(this.active)) return this.active.promise;
    if (
      !this.mounted ||
      this.state.privacyReadiness !== 'ready' ||
      this.state.mutation !== 'none'
    ) return Promise.resolve();
    if (this.state.cleanupPending || this.cleanupFailures.size > 0) {
      this.dispatch({
        type: 'analysisFailed',
        generation: this.generation,
        error: privacyError(),
        consumeSource: false,
        cleanupPending: true,
      });
      return Promise.resolve();
    }
    if (this.state.source === null) {
      this.dispatch({
        type: 'analysisFailed',
        generation: this.generation,
        error: validationError(),
        consumeSource: false,
      });
      return Promise.resolve();
    }
    const activation = this.newActivation(this.state.source, 'consentRead');
    activation.promise = this.checkConsentAndAnalyze(activation);
    return activation.promise;
  }

  private async checkConsentAndAnalyze(activation: Activation): Promise<void> {
    try {
      const accepted = await raceWithAbort(
        Promise.resolve().then(() => this.consentStore.hasCurrentConsent()),
        activation.controller.signal,
      );
      if (!this.activationIsCurrent(activation)) return;
      if (accepted !== true) {
        this.consentContinuation = {
          generation: activation.generation,
          sourceRevision: activation.sourceRevision,
        };
        this.dispatch({ type: 'consentRequired', generation: activation.generation });
        return;
      }
      activation.phase = 'network';
      await this.runNetwork(activation);
    } catch (error) {
      await this.finishPreNetwork(
        activation,
        error instanceof CoordinatorAbort ? 'cancelled' : 'consentFailure',
      );
    } finally {
      if (this.active === activation) this.active = null;
    }
  }

  private grantConsent(): Promise<void> {
    if (this.active !== null && this.activationIsCurrent(this.active)) return this.active.promise;
    if (!this.mounted || this.state.mutation !== 'none') return Promise.resolve();
    const continuation = this.consentContinuation;
    if (
      continuation === null ||
      this.state.status !== 'consentRequired' ||
      continuation.generation !== this.generation ||
      continuation.sourceRevision !== this.sourceRevision ||
      this.state.source === null
    ) return Promise.resolve();

    const activation = this.newActivation(this.state.source, 'consentWrite');
    activation.promise = this.persistConsentAndAnalyze(activation);
    return activation.promise;
  }

  private async persistConsentAndAnalyze(activation: Activation): Promise<void> {
    try {
      await raceWithAbort(
        Promise.resolve().then(() => this.consentStore.grant()),
        activation.controller.signal,
      );
      if (!this.activationIsCurrent(activation)) return;
      this.consentContinuation = null;
      activation.phase = 'network';
      await this.runNetwork(activation);
    } catch (error) {
      await this.finishPreNetwork(
        activation,
        error instanceof CoordinatorAbort ? 'cancelled' : 'consentFailure',
      );
    } finally {
      if (this.active === activation) this.active = null;
    }
  }

  private async finishPreNetwork(
    activation: Activation,
    outcome: 'cancelled' | 'consentFailure',
  ): Promise<void> {
    let consumed = false;
    if (activation.source.kind === 'pdf') {
      consumed = activation.claim !== null && await this.cleanupClaim(activation.claim);
      activation.sourceConsumed = consumed;
    }
    if (!this.activationIsCurrent(activation)) return;
    if (activation.source.kind === 'pdf' && !consumed) {
      this.dispatch({
        type: 'analysisFailed',
        generation: activation.generation,
        error: privacyError(),
        consumeSource: false,
        cleanupPending: true,
      });
      return;
    }
    if (outcome === 'cancelled') {
      this.dispatch({
        type: 'analysisCancelled',
        generation: activation.generation,
        consumeSource: consumed,
      });
    } else {
      this.dispatch({
        type: 'analysisFailed',
        generation: activation.generation,
        error: consentStorageError(),
        consumeSource: consumed,
      });
    }
  }

  private requestFor(source: ResumeSource): AnalyzeRequest {
    const trimmedJob = trimPythonWhitespace(this.state.jobDescription);
    const jobDescription = trimmedJob === null || trimmedJob.length === 0
      ? undefined
      : trimmedJob;
    if (source.kind === 'pdf') {
      return {
        source: {
          kind: 'pdf',
          uri: source.uri,
          name: 'resume.pdf',
          mimeType: 'application/pdf',
          size: source.size,
        },
        jobDescription,
        consentVersion: CONSENT_VERSION,
      };
    }
    return {
      source: { kind: source.kind, text: source.text },
      jobDescription,
      consentVersion: CONSENT_VERSION,
    };
  }

  private async runNetwork(activation: Activation): Promise<void> {
    this.dispatch({
      type: 'analysisStarted',
      generation: activation.generation,
      activation: activation.id,
    });
    let response: AnalysisResponse | null = null;
    let failure: unknown = null;
    try {
      response = await raceWithAbort(
        Promise.resolve().then(() => {
          if (activation.controller.signal.aborted) throw new CoordinatorAbort();
          return this.api.analyze(
            this.requestFor(activation.source),
            activation.controller.signal,
          );
        }),
        activation.controller.signal,
      );
    } catch (error) {
      failure = error;
    }

    let consumed = false;
    if (activation.source.kind === 'pdf') {
      consumed = activation.claim !== null && await this.cleanupClaim(activation.claim);
      activation.sourceConsumed = consumed;
      if (!consumed) {
        if (this.activationIsCurrent(activation)) {
          this.dispatch({
            type: 'analysisFailed',
            generation: activation.generation,
            activation: activation.id,
            error: privacyError(),
            consumeSource: false,
            cleanupPending: true,
          });
        }
        return;
      }
    }

    if (!this.activationIsCurrent(activation)) return;
    if (activation.controller.signal.aborted) failure = new CoordinatorAbort();
    if (failure === null && response !== null) {
      this.dispatch({
        type: 'analysisSucceeded',
        generation: activation.generation,
        activation: activation.id,
        result: response,
        consumeSource: consumed,
      });
    } else if (
      failure instanceof CoordinatorAbort ||
      (failure instanceof ResumeApiError && failure.category === 'cancelled')
    ) {
      this.dispatch({
        type: 'analysisCancelled',
        generation: activation.generation,
        activation: activation.id,
        consumeSource: consumed,
      });
    } else {
      this.dispatch({
        type: 'analysisFailed',
        generation: activation.generation,
        activation: activation.id,
        error: publicApiError(failure),
        consumeSource: consumed,
      });
    }
  }

  private declineConsent(): Promise<void> {
    if (!this.mounted) return Promise.resolve();
    if (
      this.state.status !== 'consentRequired' &&
      this.active?.phase !== 'consentWrite'
    ) return Promise.resolve();
    const source = this.state.source;
    const sourceClaim = this.committedPdfClaim;
    return this.enqueueMutation('consent', async ({ generation }) => {
      if (!(await this.cleanupUncommitted())) {
        if (this.isCurrentMutation(generation)) this.dispatchPrivacyFailure(generation, false);
        return;
      }
      let consumed = false;
      if (source?.kind === 'pdf') {
        consumed = sourceClaim === null || !this.isPdfClaimCurrent(sourceClaim) ||
          await this.cleanupClaim(sourceClaim);
        if (!this.isCurrentMutation(generation)) return;
        if (!consumed) {
          this.dispatchPrivacyFailure(generation, false);
          return;
        }
      }
      if (this.isCurrentMutation(generation)) {
        this.dispatch({ type: 'consentDeclined', generation, consumeSource: consumed });
      }
    });
  }

  private cancel(): Promise<void> {
    const active = this.active;
    if (active !== null && this.activationIsCurrent(active)) {
      active.controller.abort();
      return active.promise;
    }
    if (this.mounted && this.state.status === 'consentRequired' && this.state.mutation === 'none') {
      return this.cancelConsentRequired();
    }
    return Promise.resolve();
  }

  private cancelConsentRequired(): Promise<void> {
    const source = this.state.source;
    const sourceClaim = this.committedPdfClaim;
    return this.enqueueMutation('consent', async ({ generation }) => {
      if (!(await this.cleanupUncommitted())) {
        if (this.isCurrentMutation(generation)) this.dispatchPrivacyFailure(generation, false);
        return;
      }
      let consumed = false;
      if (source?.kind === 'pdf') {
        consumed = sourceClaim === null || !this.isPdfClaimCurrent(sourceClaim) ||
          await this.cleanupClaim(sourceClaim);
        if (!this.isCurrentMutation(generation)) return;
        if (!consumed) {
          this.dispatchPrivacyFailure(generation, false);
          return;
        }
      }
      if (this.isCurrentMutation(generation)) {
        this.dispatch({
          type: 'analysisCancelled',
          generation,
          consumeSource: consumed,
        });
      }
    });
  }

  async handleAppState(state: string): Promise<void> {
    if (state === 'background' || state === 'inactive') await this.cancel();
  }

  private reset(): Promise<void> {
    if (!this.mounted) return Promise.resolve();
    const initialization = this.initialize();
    return this.enqueueMutation('resetting', async ({ generation }) => {
      await initialization;
      const cleaned = await this.cleanupAllOwned();
      if (!this.isCurrentMutation(generation)) return;
      if (!cleaned) {
        this.dispatchPrivacyFailure(generation, false);
        return;
      }
      this.committedPdfClaim = null;
      this.dispatch({ type: 'reset', generation });
    });
  }

  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposal = this.performDisposal();
    return this.disposal;
  }

  private async performDisposal(): Promise<void> {
    const active = this.active;
    this.mounted = false;
    this.generation += 1;
    this.sourceRevision += 1;
    this.consentContinuation = null;
    active?.controller.abort();
    await this.mutationTail;
    if (active !== null) await active.promise;
    if (this.initialization !== null) await this.initialization;
    await this.cleanupAllOwned();
    this.active = null;
    this.listeners.clear();
    this.committedPdfClaim = null;
    this.state = {
      ...createInitialAnalysisState(),
      privacyReadiness: this.state.privacyReadiness,
      generation: this.generation,
    };
  }

  private dispatchPrivacyFailure(generation: number, consumeSource: boolean): void {
    this.dispatch({
      type: 'analysisFailed',
      generation,
      error: privacyError(),
      consumeSource,
      cleanupPending: true,
    });
  }

  private async cleanupUncommitted(exceptClaim: PdfClaim | null = null): Promise<boolean> {
    let clean = true;
    for (const claim of [...this.pdfClaims.values()]) {
      const isCommitted = this.committedPdfClaim !== null &&
        this.committedPdfClaim.requestId === claim.requestId &&
        this.committedPdfClaim.lease === claim.lease &&
        this.isPdfClaimCurrent(this.committedPdfClaim);
      const isExcepted = exceptClaim !== null &&
        exceptClaim.requestId === claim.requestId &&
        exceptClaim.lease === claim.lease &&
        this.isPdfClaimCurrent(exceptClaim);
      if (isCommitted || isExcepted) continue;
      if (!(await this.cleanupClaim(claim))) clean = false;
    }
    return clean;
  }

  private async cleanupAllOwned(): Promise<boolean> {
    let clean = true;
    for (const claim of [...this.pdfClaims.values()]) {
      if (!(await this.cleanupClaim(claim))) clean = false;
    }
    return clean;
  }

  private cleanupClaim(claim: PdfClaim): Promise<boolean> {
    const current = this.cleanupOperations.get(claim.lease);
    if (current !== undefined) return current;
    const operation = this.performCleanupClaim(claim);
    this.cleanupOperations.set(claim.lease, operation);
    void operation.finally(() => {
      if (this.cleanupOperations.get(claim.lease) === operation) {
        this.cleanupOperations.delete(claim.lease);
      }
    }).catch(() => undefined);
    return operation;
  }

  private async performCleanupClaim(claim: PdfClaim): Promise<boolean> {
    try {
      const receipt = await this.boundedCleanup(() =>
        this.tempFiles.cleanupRequest(claim.requestId, claim.lease));
      if (isStaleLeaseReceipt(receipt) && !this.isPdfClaimCurrent(claim)) {
        this.cleanupFailures.delete(claim.lease);
        return true;
      }
      if (!isVerifiedCleanupReceipt(receipt)) {
        this.cleanupFailures.add(claim.lease);
        return false;
      }
      this.cleanupFailures.delete(claim.lease);
      const current = this.pdfClaims.get(claim.requestId);
      if (current?.lease === claim.lease && current.epoch === claim.epoch) {
        this.pdfClaims.delete(claim.requestId);
        this.ownedPdfRequestIds.delete(claim.requestId);
        if (this.committedPdfClaim === current) this.committedPdfClaim = null;
      }
      return true;
    } catch {
      this.cleanupFailures.add(claim.lease);
      return false;
    }
  }

  private boundedCleanup(operation: () => Promise<CleanupReceipt>): Promise<CleanupReceipt> {
    return new Promise<CleanupReceipt>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new CleanupTimeout());
      }, this.cleanupTimeoutMs);
      let promise: Promise<CleanupReceipt>;
      try {
        promise = operation();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      Promise.resolve(promise).then(
        receipt => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(receipt);
        },
        error => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }
}
