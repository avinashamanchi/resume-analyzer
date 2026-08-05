import { validateApiBaseUrl } from './apiBaseUrl';
import { CONSENT_VERSION } from '../domain/consent';
import { parseAnalysisResponse, PublicErrorSchema, type AnalysisResponse } from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';
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
  getOrIssue(signal: AbortSignal): Promise<string>;
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

function appendTextSource(formData: FormData, source: unknown): void {
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
  formData.append('resume_text', source.text);
  formData.append('source_type', source.kind);
}

function appendPdfSource(formData: FormData, source: unknown): void {
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
  formData.append(
    'resume_pdf',
    { uri: source.uri, name: source.name, type: source.mimeType } as unknown as string,
  );
}

function createMultipartPayload(request: unknown, requestId: unknown): MultipartPayload {
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
  const formData = new FormData();
  formData.append('consent_version', CONSENT_VERSION);
  formData.append('request_id', assertCanonicalRequestId(requestId));

  let hasJobDescription = false;
  if (request.jobDescription !== undefined && request.jobDescription !== null) {
    if (typeof request.jobDescription !== 'string' || codePointLength(request.jobDescription) > MAX_JOB_DESCRIPTION_CODE_POINTS) {
      throw new ResumeApiError('validation');
    }
    const trimmed = trimPythonWhitespace(request.jobDescription);
    if (trimmed === null) throw new ResumeApiError('validation');
    if (trimmed.length > 0) {
      formData.append('job_description', trimmed);
      hasJobDescription = true;
    }
  }

  const source = request.source as Record<string, unknown>;
  if (source.kind === 'pdf') appendPdfSource(formData, source);
  else if (source.kind === 'text' || source.kind === 'vision_text') {
    appendTextSource(formData, source);
  } else {
    throw new ResumeApiError('validation');
  }

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
    let payload: MultipartPayload;
    try {
      payload = createMultipartPayload(input, this.requestId());
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
      // The token store owns its explicit commit phase: wrapping it in a
      // second abort race could report cancellation while its authority
      // finalize later commits. It still receives the controller signal for
      // pre-commit cancellation and timeout handling.
      const token = await this.installationTokens.getOrIssue(controller.signal);
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
      if (error instanceof ResumeApiError) throw error;
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
