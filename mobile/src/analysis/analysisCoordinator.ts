import { CONSENT_VERSION } from '../domain/consent';
import type { AnalysisResponse } from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';
import {
  codePointLength,
  MAX_JOB_DESCRIPTION_CODE_POINTS,
  MAX_PDF_BYTES,
  MAX_RESUME_CODE_POINTS,
  isNonBlankPythonText,
  trimPythonWhitespace,
} from '../domain/limits';
import type { AnalyzeRequest } from '../api/resumeApi';
import type { ResumeSource } from '../documents/documentSource';
import {
  canonicalizeLocalFileUri,
  type CleanupReceipt,
} from '../documents/tempFileRegistry';
import {
  analysisReducer,
  createInitialAnalysisState,
  type AnalysisEvent,
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
  cleanupRequest(requestId: string): Promise<CleanupReceipt>;
}>;

export type AnalysisCoordinatorOptions = Readonly<{
  api: AnalysisApiPort;
  consentStore: AnalysisConsentStorePort;
  tempFiles: AnalysisTempFilesPort;
  cleanupTimeoutMs?: number;
}>;

export type AnalysisCommands = Readonly<{
  selectSource(source: ResumeSource): Promise<void>;
  setJobDescription(value: string): Promise<void>;
  analyze(): Promise<void>;
  grantConsent(): Promise<void>;
  declineConsent(): Promise<void>;
  cancel(): Promise<void>;
  reset(): Promise<void>;
}>;

type Activation = {
  readonly id: number;
  readonly generation: number;
  readonly sourceRevision: number;
  readonly source: ResumeSource;
  readonly controller: AbortController;
  sourceConsumed: boolean;
  promise: Promise<void>;
};

type ConsentContinuation = Readonly<{
  generation: number;
  sourceRevision: number;
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

function validSource(source: unknown): source is ResumeSource {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  const candidate = source as Record<string, unknown>;
  if (candidate.kind === 'text') {
    return typeof candidate.text === 'string' &&
      !candidate.text.includes('\0') &&
      isNonBlankPythonText(candidate.text) &&
      codePointLength(candidate.text) <= MAX_RESUME_CODE_POINTS;
  }
  if (candidate.kind === 'vision_text') {
    return candidate.reviewed === true &&
      typeof candidate.text === 'string' &&
      !candidate.text.includes('\0') &&
      isNonBlankPythonText(candidate.text) &&
      codePointLength(candidate.text) <= MAX_RESUME_CODE_POINTS;
  }
  if (
    candidate.kind !== 'pdf' ||
    typeof candidate.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(candidate.requestId) ||
    typeof candidate.uri !== 'string' ||
    typeof candidate.size !== 'number' ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size <= 0 ||
    candidate.size > MAX_PDF_BYTES
  ) return false;
  try {
    const location = canonicalizeLocalFileUri(candidate.uri);
    const finalSegments = location.segments.slice(-3);
    const filename = finalSegments[2] ?? '';
    return finalSegments[0] === 'resume-ai-v1' &&
      finalSegments[1] === candidate.requestId &&
      REQUEST_ID_PATTERN.test(filename.slice(0, -4)) &&
      filename.endsWith('.pdf');
  } catch {
    return false;
  }
}

function snapshotSource(source: ResumeSource): ResumeSource {
  if (source.kind === 'pdf') {
    return Object.freeze({
      kind: 'pdf',
      requestId: source.requestId,
      uri: source.uri,
      size: source.size,
    });
  }
  if (source.kind === 'vision_text') {
    return Object.freeze({
      kind: 'vision_text',
      text: source.text,
      reviewed: true,
      ...(source.pageCount === undefined ? {} : { pageCount: source.pageCount }),
    });
  }
  return Object.freeze({ kind: 'text', text: source.text });
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
  private readonly cleanupTimeoutMs: number;
  private generation = 0;
  private sourceRevision = 0;
  private nextActivation = 0;
  private active: Activation | null = null;
  private consentContinuation: ConsentContinuation | null = null;
  private initialization: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private mounted = true;
  private pendingCleanupRequestId: string | null = null;

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
    if (!this.mounted) return;
    this.dispatch(ready
      ? { type: 'initializationReady' }
      : { type: 'initializationFailed', error: privacyError() });
  }

  private dispatch(event: AnalysisEvent): void {
    if (!this.mounted) return;
    const next = analysisReducer(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private advanceGeneration(): { generation: number; previous: Activation | null } {
    const previous = this.active;
    this.generation += 1;
    this.sourceRevision += 1;
    this.consentContinuation = null;
    previous?.controller.abort();
    this.dispatch({ type: 'generationAdvanced', generation: this.generation });
    return { generation: this.generation, previous };
  }

  private stillCurrent(generation: number): boolean {
    return this.mounted && generation === this.generation;
  }

  private activationIsCurrent(activation: Activation): boolean {
    return this.mounted &&
      this.active === activation &&
      activation.generation === this.generation &&
      activation.sourceRevision === this.sourceRevision;
  }

  private async selectSource(source: ResumeSource): Promise<void> {
    await this.initialize();
    if (!this.mounted || this.state.privacyReadiness !== 'ready') return;
    const previousSource = this.state.source;
    const { generation, previous } = this.advanceGeneration();
    if (previous !== null) await previous.promise;

    if (previousSource?.kind === 'pdf') {
      const cleaned = await this.cleanupRequest(previousSource.requestId);
      if (!this.stillCurrent(generation)) return;
      if (!cleaned) {
        this.dispatch({
          type: 'analysisFailed',
          generation,
          error: privacyError(),
          consumeSource: false,
          cleanupPending: true,
        });
        return;
      }
    }
    if (!this.stillCurrent(generation)) return;
    if (!validSource(source)) {
      this.dispatch({
        type: 'analysisFailed',
        generation,
        error: validationError(),
        consumeSource: true,
      });
      return;
    }
    this.dispatch({ type: 'sourceReady', generation, source: snapshotSource(source) });
  }

  private async setJobDescription(value: string): Promise<void> {
    await this.initialize();
    if (!this.mounted || this.state.privacyReadiness !== 'ready') return;
    const source = this.state.source;
    const { generation, previous } = this.advanceGeneration();
    if (previous !== null) await previous.promise;
    if (!this.stillCurrent(generation)) return;
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      codePointLength(value) > MAX_JOB_DESCRIPTION_CODE_POINTS
    ) {
      this.dispatch({
        type: 'analysisFailed',
        generation,
        error: validationError(),
        consumeSource: false,
      });
      return;
    }
    let consumeSource = previous?.sourceConsumed === true;
    if (
      source?.kind === 'pdf' &&
      !consumeSource &&
      this.pendingCleanupRequestId === source.requestId
    ) {
      consumeSource = await this.cleanupRequest(source.requestId);
      if (!this.stillCurrent(generation)) return;
      if (!consumeSource) {
        this.dispatch({
          type: 'analysisFailed',
          generation,
          error: privacyError(),
          consumeSource: false,
          cleanupPending: true,
        });
        return;
      }
    }
    this.dispatch({
      type: 'jobUpdated',
      generation,
      jobDescription: value,
      consumeSource,
    });
  }

  private newActivation(source: ResumeSource): Activation {
    const activation: Activation = {
      id: ++this.nextActivation,
      generation: this.generation,
      sourceRevision: this.sourceRevision,
      source,
      controller: new AbortController(),
      sourceConsumed: false,
      promise: Promise.resolve(),
    };
    this.active = activation;
    return activation;
  }

  private analyze(): Promise<void> {
    if (this.active !== null && this.activationIsCurrent(this.active)) return this.active.promise;
    if (this.mounted && this.state.privacyReadiness === 'ready' && this.state.cleanupPending) {
      this.dispatch({
        type: 'analysisFailed',
        generation: this.generation,
        error: privacyError(),
        consumeSource: false,
        cleanupPending: true,
      });
      return Promise.resolve();
    }
    if (
      !this.mounted ||
      this.state.privacyReadiness !== 'ready' ||
      this.state.source === null ||
      !validSource(this.state.source)
    ) {
      if (this.mounted && this.state.privacyReadiness === 'ready') {
        this.dispatch({
          type: 'analysisFailed',
          generation: this.generation,
          error: validationError(),
          consumeSource: false,
        });
      }
      return Promise.resolve();
    }
    const activation = this.newActivation(this.state.source);
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
      if (!accepted) {
        this.consentContinuation = {
          generation: activation.generation,
          sourceRevision: activation.sourceRevision,
        };
        this.dispatch({ type: 'consentRequired', generation: activation.generation });
        return;
      }
      await this.runNetwork(activation);
    } catch (error) {
      if (!this.activationIsCurrent(activation)) return;
      if (error instanceof CoordinatorAbort) {
        this.dispatch({
          type: 'analysisCancelled',
          generation: activation.generation,
          consumeSource: false,
        });
      } else {
        this.dispatch({
          type: 'analysisFailed',
          generation: activation.generation,
          error: consentStorageError(),
          consumeSource: false,
        });
      }
    } finally {
      if (this.active === activation) this.active = null;
    }
  }

  private grantConsent(): Promise<void> {
    if (this.active !== null && this.activationIsCurrent(this.active)) return this.active.promise;
    const continuation = this.consentContinuation;
    if (
      continuation === null ||
      this.state.status !== 'consentRequired' ||
      continuation.generation !== this.generation ||
      continuation.sourceRevision !== this.sourceRevision ||
      this.state.source === null
    ) return Promise.resolve();

    const activation = this.newActivation(this.state.source);
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
      await this.runNetwork(activation);
    } catch (error) {
      if (!this.activationIsCurrent(activation)) return;
      if (error instanceof CoordinatorAbort) {
        this.dispatch({
          type: 'analysisCancelled',
          generation: activation.generation,
          consumeSource: false,
        });
      } else {
        this.dispatch({
          type: 'analysisFailed',
          generation: activation.generation,
          error: consentStorageError(),
          consumeSource: false,
        });
      }
    } finally {
      if (this.active === activation) this.active = null;
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
        Promise.resolve().then(() => this.api.analyze(
          this.requestFor(activation.source),
          activation.controller.signal,
        )),
        activation.controller.signal,
      );
    } catch (error) {
      failure = error;
    }

    let consumed = false;
    if (activation.source.kind === 'pdf') {
      consumed = await this.cleanupRequest(activation.source.requestId);
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

  private async declineConsent(): Promise<void> {
    if (!this.mounted) return;
    this.consentContinuation = null;
    this.dispatch({ type: 'consentDeclined', generation: this.generation });
  }

  private async cancel(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    active.controller.abort();
    await active.promise;
  }

  async handleAppState(state: string): Promise<void> {
    if (state === 'background' || state === 'inactive') await this.cancel();
  }

  private async reset(): Promise<void> {
    if (!this.mounted) return;
    const source = this.state.source;
    const { generation, previous } = this.advanceGeneration();
    if (previous !== null) await previous.promise;
    if (source?.kind === 'pdf') {
      const cleaned = await this.cleanupRequest(source.requestId);
      if (!this.stillCurrent(generation)) return;
      if (!cleaned) {
        this.dispatch({
          type: 'analysisFailed',
          generation,
          error: privacyError(),
          consumeSource: false,
          cleanupPending: true,
        });
        return;
      }
    }
    if (this.stillCurrent(generation)) this.dispatch({ type: 'reset', generation });
  }

  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposal = this.performDisposal();
    return this.disposal;
  }

  private async performDisposal(): Promise<void> {
    const source = this.state.source;
    const active = this.active;
    this.mounted = false;
    this.generation += 1;
    this.sourceRevision += 1;
    this.consentContinuation = null;
    active?.controller.abort();
    if (active !== null) await active.promise;
    if (source?.kind === 'pdf') await this.cleanupRequest(source.requestId);
    this.active = null;
    this.listeners.clear();
    this.state = {
      ...createInitialAnalysisState(),
      privacyReadiness: this.state.privacyReadiness,
      generation: this.generation,
    };
  }

  private async cleanupRequest(requestId: string): Promise<boolean> {
    try {
      const receipt = await this.boundedCleanup(() => this.tempFiles.cleanupRequest(requestId));
      if (!isVerifiedCleanupReceipt(receipt)) {
        this.pendingCleanupRequestId = requestId;
        return false;
      }
      if (this.pendingCleanupRequestId === requestId) this.pendingCleanupRequestId = null;
      return true;
    } catch {
      this.pendingCleanupRequestId = requestId;
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
