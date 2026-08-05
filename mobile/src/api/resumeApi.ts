import { validateApiBaseUrl } from './apiBaseUrl';
import { CONSENT_VERSION } from '../domain/consent';
import { parseAnalysisResponse, PublicErrorSchema, type AnalysisResponse } from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';
import type { InstallationTokenAcquisitionObserver } from '../security/installationToken';
import {
  codePointLength,
  isNonBlankPythonText,
  MAX_JOB_DESCRIPTION_CODE_POINTS,
  MAX_PDF_BYTES,
  MAX_RESUME_CODE_POINTS,
  trimPythonWhitespace,
} from '../domain/limits';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export type PdfAnalyzeSource = Readonly<{
  kind: 'pdf';
  uri: string;
  name: string;
  mimeType: 'application/pdf';
  size: number;
}>;

export type TextAnalyzeSource = Readonly<{
  kind: 'text' | 'vision_text';
  text: string;
}>;

export type AnalyzeRequest = Readonly<{
  source: PdfAnalyzeSource | TextAnalyzeSource;
  jobDescription?: string | null;
  consentVersion: string;
}>;

export type InstallationTokenProvider = Readonly<{
  getOrIssue(signal: AbortSignal, observer?: InstallationTokenAcquisitionObserver): Promise<string>;
  clear(): Promise<void>;
  invalidate(expectedToken: string): Promise<void>;
}>;

export type ResumeApiOptions = Readonly<{
  apiBaseUrl: string;
  installationTokens: InstallationTokenProvider;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  requestId?: () => string;
}>;

type MultipartPayload = Readonly<{
  body: FormData;
  hasJobDescription: boolean;
}>;

class AbortSignalFailure extends Error {}
class TokenAcquisitionIndeterminateFailure extends Error {}

type TokenCommitObservation = Readonly<{
  observer: InstallationTokenAcquisitionObserver;
  hasStarted(): boolean;
}>;

function defaultRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid !== 'function') throw new ResumeApiError('validation');
  return randomUuid.call(globalThis.crypto);
}

function assertExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertCanonicalRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ResumeApiError('validation');
  return value;
}

function validateTextSource(source: unknown): void {
  if (
    !assertExactKeys(source, ['kind', 'text']) ||
    (source.kind !== 'text' && source.kind !== 'vision_text') ||
    typeof source.text !== 'string'
  ) {
    throw new ResumeApiError('validation');
  }
  if (!isNonBlankPythonText(source.text) || codePointLength(source.text) > MAX_RESUME_CODE_POINTS) {
    throw new ResumeApiError('validation');
  }
}

function appendTextSource(formData: FormData, source: unknown): void {
  validateTextSource(source);
  const textSource = source as TextAnalyzeSource;
  formData.append('resume_text', textSource.text);
  formData.append('source_type', textSource.kind);
}

function validatePdfSource(source: unknown): void {
  if (
    !assertExactKeys(source, ['kind', 'uri', 'name', 'mimeType', 'size']) ||
    source.kind !== 'pdf' ||
    typeof source.uri !== 'string' ||
    !isNonBlankPythonText(source.uri) ||
    typeof source.name !== 'string' ||
    codePointLength(source.name) === 0 ||
    codePointLength(source.name) > 255 ||
    !source.name.toLowerCase().endsWith('.pdf') ||
    source.mimeType !== 'application/pdf' ||
    typeof source.size !== 'number' ||
    !Number.isInteger(source.size) ||
    source.size < 0 ||
    source.size > MAX_PDF_BYTES
  ) {
    throw new ResumeApiError('validation');
  }
}

function appendPdfSource(formData: FormData, source: unknown): void {
  validatePdfSource(source);
  const pdfSource = source as PdfAnalyzeSource;
  formData.append(
    'resume_pdf',
    { uri: pdfSource.uri, name: pdfSource.name, type: pdfSource.mimeType } as unknown as string,
  );
}

// Keep validation separate from FormData allocation. Token acquisition may
// reconcile durably after its caller has timed out, so no multipart copy of
// resume content exists until an authorized token is ready.
function validateAnalyzeRequest(request: unknown, requestId: unknown): void {
  if (!assertExactKeys(request, ['source', 'jobDescription', 'consentVersion']) &&
      !assertExactKeys(request, ['source', 'consentVersion'])) {
    throw new ResumeApiError('validation');
  }
  if (typeof request.consentVersion !== 'string' || request.consentVersion !== CONSENT_VERSION) {
    throw new ResumeApiError('validation');
  }
  if (request.source === null || typeof request.source !== 'object' || Array.isArray(request.source)) {
    throw new ResumeApiError('validation');
  }
  assertCanonicalRequestId(requestId);

  if (request.jobDescription !== undefined && request.jobDescription !== null) {
    if (typeof request.jobDescription !== 'string' || codePointLength(request.jobDescription) > MAX_JOB_DESCRIPTION_CODE_POINTS) {
      throw new ResumeApiError('validation');
    }
    if (trimPythonWhitespace(request.jobDescription) === null) throw new ResumeApiError('validation');
  }

  const source = request.source as Record<string, unknown>;
  if (source.kind === 'pdf') validatePdfSource(source);
  else if (source.kind === 'text' || source.kind === 'vision_text') validateTextSource(source);
  else throw new ResumeApiError('validation');
}

function createMultipartPayload(request: AnalyzeRequest, requestId: unknown): MultipartPayload {
  validateAnalyzeRequest(request, requestId);
  const formData = new FormData();
  formData.append('consent_version', CONSENT_VERSION);
  formData.append('request_id', assertCanonicalRequestId(requestId));

  let hasJobDescription = false;
  if (request.jobDescription !== undefined && request.jobDescription !== null) {
    const trimmed = trimPythonWhitespace(request.jobDescription);
    if (trimmed === null) throw new ResumeApiError('validation');
    if (trimmed.length > 0) {
      formData.append('job_description', trimmed);
      hasJobDescription = true;
    }
  }

  const source = request.source as Record<string, unknown>;
  if (source.kind === 'pdf') appendPdfSource(formData, source);
  else appendTextSource(formData, source);

  return { body: formData, hasJobDescription };
}

async function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AbortSignalFailure();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new AbortSignalFailure());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function awaitTokenAcquisition<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  commitStarted: () => boolean,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(commitStarted() ? new TokenAcquisitionIndeterminateFailure() : new AbortSignalFailure());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(commitStarted() ? new TokenAcquisitionIndeterminateFailure() : new AbortSignalFailure());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

// This factory owns only the commit bit. Keeping it outside analyze prevents
// the observer retained by token issuance from closing over resume input.
function observeTokenCommit(): TokenCommitObservation {
  let started = false;
  return {
    observer: { onCommit: () => { started = true; } },
    hasStarted: () => started,
  };
}

async function parseJsonOnce(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await awaitAbortable(response.json(), signal);
  } catch (error) {
    if (error instanceof AbortSignalFailure) throw error;
    throw new ResumeApiError('invalid_response');
  }
}

export class ResumeApi {
  private readonly apiBaseUrl: string;
  private readonly installationTokens: InstallationTokenProvider;
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly requestId: () => string;

  constructor(options: ResumeApiOptions) {
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.installationTokens = options.installationTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.requestId = options.requestId ?? defaultRequestId;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new TypeError('A bounded request timeout is required.');
    }
  }

  async analyze(input: AnalyzeRequest, signal: AbortSignal): Promise<AnalysisResponse> {
    if (signal.aborted) throw new ResumeApiError('cancelled');
    let requestId: string;
    try {
      requestId = this.requestId();
      validateAnalyzeRequest(input, requestId);
    } catch (error) {
      if (error instanceof ResumeApiError) throw error;
      throw new ResumeApiError('validation');
    }
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    signal.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const tokenCommit = observeTokenCommit();
      const token = await awaitTokenAcquisition(
        this.installationTokens.getOrIssue(controller.signal, tokenCommit.observer),
        controller.signal,
        tokenCommit.hasStarted,
      );
      // A provider may settle in the same turn as caller or timeout abort.
      // Never send sensitive analysis input with an already-aborted signal.
      if (controller.signal.aborted) throw new AbortSignalFailure();
      let payload: MultipartPayload;
      try {
        payload = createMultipartPayload(input, requestId);
      } catch (error) {
        if (error instanceof ResumeApiError) throw error;
        throw new ResumeApiError('validation');
      }
      const response = await awaitAbortable(
        this.fetchImpl(`${this.apiBaseUrl}/v1/analyses`, {
          method: 'POST',
          headers: { Authorization: `Installation ${token}` },
          body: payload.body,
          signal: controller.signal,
        }),
        controller.signal,
      );
      const data = await parseJsonOnce(response, controller.signal);
      if (response.status === 200) {
        try {
          return parseAnalysisResponse(data, Object.freeze({ hasJobDescription: payload.hasJobDescription }));
        } catch {
          throw new ResumeApiError('invalid_response');
        }
      }
      const publicError = PublicErrorSchema.safeParse(data);
      if (!publicError.success) throw new ResumeApiError('invalid_response');
      if (response.status === 401 && publicError.data.code === 'invalid_installation') {
        this.scheduleTokenInvalidation(token);
      }
      throw new ResumeApiError('service', publicError.data);
    } catch (error) {
      if (error instanceof TokenAcquisitionIndeterminateFailure) {
        throw new ResumeApiError('indeterminate', { retryable: true });
      }
      if (error instanceof ResumeApiError) {
        if (error.category === 'cancelled' && controller.signal.aborted) {
          throw new ResumeApiError(timedOut ? 'timeout' : 'cancelled');
        }
        throw error;
      }
      if (error instanceof AbortSignalFailure || controller.signal.aborted) {
        throw new ResumeApiError(timedOut ? 'timeout' : 'cancelled');
      }
      throw new ResumeApiError('network');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abortFromCaller);
    }
  }

  private scheduleTokenInvalidation(expectedToken: string): void {
    try {
      const operation = this.installationTokens.invalidate(expectedToken);
      void Promise.resolve(operation).catch(() => undefined);
    } catch {
      // A future explicit submit can issue a new anonymous token; never replay this request.
    }
  }
}
