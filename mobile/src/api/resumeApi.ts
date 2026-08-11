import { validateApiBaseUrl } from './apiBaseUrl';
import { CONSENT_VERSION } from '../domain/consent';
import {
  parseAnalysisResponseV2,
  InstallationTokenSchema,
  PublicErrorSchema,
  type AnalysisResult,
} from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';
import {
  AccountIdentitySchema,
  type AccountIdentity,
} from '../security/accountIdentity';
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
const MAX_RESPONSE_BYTES = 65_536;

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export type PdfAnalyzeSource = Readonly<{
  kind: 'pdf';
  uri: string;
  name: string;
  mimeType: 'application/pdf';
  size: number;
}>;

export type TextAnalyzeSource = Readonly<{
  kind: 'text' | 'vision_text' | 'reviewed_text';
  text: string;
}>;

export type AnalyzeRequest = Readonly<{
  source: PdfAnalyzeSource | TextAnalyzeSource;
  jobDescription?: string | null;
  consentVersion: string;
  aiRequested?: boolean;
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
  accountIdentity?: Readonly<{ get(): Promise<AccountIdentity | null> }>;
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
    (source.kind !== 'text' && source.kind !== 'vision_text' && source.kind !== 'reviewed_text') ||
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
  if (
    request === null ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !Object.prototype.hasOwnProperty.call(request, 'source') ||
    !Object.prototype.hasOwnProperty.call(request, 'consentVersion') ||
    !Object.keys(request).every(key =>
      key === 'source' ||
      key === 'jobDescription' ||
      key === 'consentVersion' ||
      key === 'aiRequested',
    )
  ) {
    throw new ResumeApiError('validation');
  }
  const candidate = request as Record<string, unknown>;
  if (typeof candidate.consentVersion !== 'string' || candidate.consentVersion !== CONSENT_VERSION) {
    throw new ResumeApiError('validation');
  }
  if (candidate.source === null || typeof candidate.source !== 'object' || Array.isArray(candidate.source)) {
    throw new ResumeApiError('validation');
  }
  assertCanonicalRequestId(requestId);
  if (candidate.aiRequested !== undefined && typeof candidate.aiRequested !== 'boolean') {
    throw new ResumeApiError('validation');
  }

  if (candidate.jobDescription !== undefined && candidate.jobDescription !== null) {
    if (typeof candidate.jobDescription !== 'string' || codePointLength(candidate.jobDescription) > MAX_JOB_DESCRIPTION_CODE_POINTS) {
      throw new ResumeApiError('validation');
    }
    if (trimPythonWhitespace(candidate.jobDescription) === null) throw new ResumeApiError('validation');
  }

  const source = candidate.source as Record<string, unknown>;
  if (source.kind === 'pdf') validatePdfSource(source);
  else if (
    source.kind === 'text' ||
    source.kind === 'vision_text' ||
    source.kind === 'reviewed_text'
  ) validateTextSource(source);
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
  const declared = typeof response.headers?.get === 'function'
    ? response.headers.get('content-length')
    : null;
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    throw new ResumeApiError('invalid_response');
  }
  try {
    if (typeof response.text === 'function') {
      const body = await awaitAbortable(response.text(), signal);
      let byteLength = 0;
      for (const character of body) {
        const point = character.codePointAt(0)!;
        byteLength += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (byteLength > MAX_RESPONSE_BYTES) throw new ResumeApiError('invalid_response');
      }
      return JSON.parse(body) as unknown;
    }
    return await awaitAbortable(response.json(), signal);
  } catch (error) {
    if (error instanceof AbortSignalFailure || error instanceof ResumeApiError) throw error;
    throw new ResumeApiError('invalid_response');
  }
}

export class ResumeApi {
  private readonly apiBaseUrl: string;
  private readonly installationTokens: InstallationTokenProvider;
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly requestId: () => string;
  private readonly accountIdentity: Readonly<{ get(): Promise<AccountIdentity | null> }>;

  constructor(options: ResumeApiOptions) {
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.installationTokens = options.installationTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.requestId = options.requestId ?? defaultRequestId;
    this.accountIdentity = options.accountIdentity ?? Object.freeze({
      get: async () => null,
    });
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new TypeError('A bounded request timeout is required.');
    }
  }

  async analyze(input: AnalyzeRequest, signal: AbortSignal): Promise<AnalysisResult> {
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
      const parsedToken = InstallationTokenSchema.safeParse(token);
      if (!parsedToken.success) throw new ResumeApiError('invalid_response');
      const account = await awaitAbortable(
        this.accountIdentity.get(),
        controller.signal,
      );
      const parsedAccount = account === null ? null : AccountIdentitySchema.safeParse(account);
      if (parsedAccount !== null && !parsedAccount.success) {
        throw new ResumeApiError('invalid_response');
      }
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
        this.fetchImpl(`${this.apiBaseUrl}/v2/analyses`, {
          method: 'POST',
          headers: {
            Authorization: `Installation ${parsedToken.data}`,
            'X-Resume-Source': input.source.kind === 'pdf' ? 'pdf' : 'reviewed_text',
            'X-Resume-AI': input.aiRequested === false ? 'not_requested' : 'requested',
            'X-Resume-Request-ID': requestId,
            ...(parsedAccount === null
              ? {}
              : { 'X-Resume-Account': parsedAccount.data.accountToken }),
          },
          body: payload.body,
          signal: controller.signal,
        }),
        controller.signal,
      );
      const data = await parseJsonOnce(response, controller.signal);
      if (response.status === 200) {
        try {
          return parseAnalysisResponseV2(
            data,
            Object.freeze({ hasJobDescription: payload.hasJobDescription }),
          );
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
