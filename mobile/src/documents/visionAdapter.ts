import { requireOptionalNativeModule, uuid } from 'expo-modules-core';

import {
  MAX_PDF_BYTES,
  MAX_RESUME_CODE_POINTS,
  codePointLength,
  isNonBlankPythonText,
} from '../domain/limits';
import type { PdfSource, VisionTextSource } from './documentSource';
import { canonicalizeLocalFileUri } from './tempFileRegistry';

type NativeVisionResult = Readonly<{
  text: string;
  pageCount: number;
}>;

type NativeVisionModule = Readonly<{
  extractTextFromPdf(uri: string, operationId: string): Promise<NativeVisionResult>;
  cancelExtraction(operationId: string): Promise<void>;
}>;

type VisionAdapterOptions = Readonly<{
  lookup?: () => NativeVisionModule | null;
  operationId?: () => string;
}>;

export type VisionExtractionErrorCode =
  | 'vision_unavailable'
  | 'vision_invalid_source'
  | 'vision_native_failure'
  | 'vision_invalid_result';

export class VisionExtractionError extends Error {
  readonly category = 'unsupported_pdf' as const;
  readonly code: VisionExtractionErrorCode;
  readonly developmentBuildRequired: boolean;
  readonly route = 'paste_text' as const;

  constructor(code: VisionExtractionErrorCode, developmentBuildRequired: boolean) {
    super('This PDF needs reviewed text before it can be analyzed.');
    this.name = 'VisionExtractionError';
    this.code = code;
    this.developmentBuildRequired = developmentBuildRequired;
  }
}

export { VisionExtractionError as VisionUnavailableError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function validatedSourceUri(source: unknown): string {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new VisionExtractionError('vision_invalid_source', false);
  }
  const candidate = source as Record<string, unknown>;
  if (
    !exactKeys(candidate, ['kind', 'requestId', 'uri', 'size', 'lease']) ||
    candidate.kind !== 'pdf' ||
    typeof candidate.requestId !== 'string' ||
    !UUID.test(candidate.requestId) ||
    typeof candidate.lease !== 'symbol' ||
    typeof candidate.size !== 'number' ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size <= 0 ||
    candidate.size > MAX_PDF_BYTES
  ) {
    throw new VisionExtractionError('vision_invalid_source', false);
  }

  try {
    const location = canonicalizeLocalFileUri(candidate.uri);
    const segments = location.segments;
    const requestId = segments.at(-2);
    const filename = segments.at(-1);
    if (
      segments.at(-3) !== 'resume-ai-v1' ||
      requestId !== candidate.requestId ||
      typeof filename !== 'string' ||
      !UUID.test(filename.slice(0, -4)) ||
      !filename.endsWith('.pdf')
    ) throw new Error('invalid');
    return location.uri;
  } catch {
    throw new VisionExtractionError('vision_invalid_source', false);
  }
}

function defaultLookup(): NativeVisionModule | null {
  try {
    return requireOptionalNativeModule<NativeVisionModule>('ResumeVision');
  } catch {
    return null;
  }
}

export class VisionAdapter {
  private readonly lookup: () => NativeVisionModule | null;
  private readonly operationId: () => string;
  private readonly activeOperations = new Map<symbol, Readonly<{
    id: string;
    nativeModule: NativeVisionModule;
  }>>();

  constructor(options: VisionAdapterOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup;
    this.operationId = options.operationId ?? (() => uuid.v4().toLowerCase());
  }

  private module(): NativeVisionModule | null {
    try {
      const candidate = this.lookup();
      return candidate !== null &&
        typeof candidate.extractTextFromPdf === 'function' &&
        typeof candidate.cancelExtraction === 'function'
        ? candidate
        : null;
    } catch {
      return null;
    }
  }

  isAvailable(): boolean {
    return this.module() !== null;
  }

  async extractReviewedText(source: PdfSource, authority: symbol): Promise<VisionTextSource> {
    const nativeModule = this.module();
    if (nativeModule === null) {
      throw new VisionExtractionError('vision_unavailable', true);
    }

    const canonicalUri = validatedSourceUri(source);
    if (typeof authority !== 'symbol' || this.activeOperations.has(authority)) {
      throw new VisionExtractionError('vision_invalid_source', false);
    }
    let operationId: string;
    try {
      operationId = this.operationId();
    } catch {
      throw new VisionExtractionError('vision_native_failure', false);
    }
    if (typeof operationId !== 'string' || !UUID.test(operationId)) {
      throw new VisionExtractionError('vision_native_failure', false);
    }
    if ([...this.activeOperations.values()].some(operation => operation.id === operationId)) {
      throw new VisionExtractionError('vision_native_failure', false);
    }
    this.activeOperations.set(authority, Object.freeze({ id: operationId, nativeModule }));

    let result: NativeVisionResult;
    try {
      result = await nativeModule.extractTextFromPdf(canonicalUri, operationId);
    } catch {
      throw new VisionExtractionError('vision_native_failure', false);
    } finally {
      this.activeOperations.delete(authority);
    }
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !exactKeys(result, ['text', 'pageCount']) ||
      typeof result?.text !== 'string' ||
      result.text.includes('\0') ||
      !isNonBlankPythonText(result.text) ||
      codePointLength(result.text) > MAX_RESUME_CODE_POINTS ||
      !Number.isSafeInteger(result.pageCount) ||
      result.pageCount <= 0 ||
      result.pageCount > 10
    ) {
      throw new VisionExtractionError('vision_invalid_result', false);
    }

    return Object.freeze({
      kind: 'vision_text',
      text: result.text,
      reviewed: false,
      pageCount: result.pageCount,
    });
  }

  async cancelExtraction(authority: symbol): Promise<void> {
    if (typeof authority !== 'symbol') return;
    const operation = this.activeOperations.get(authority);
    if (operation === undefined) return;
    try {
      await operation.nativeModule.cancelExtraction(operation.id);
    } catch {
      // Cancellation is best effort; extraction settlement remains authoritative.
    }
  }
}
