import { requireOptionalNativeModule } from 'expo-modules-core';

import { MAX_RESUME_CODE_POINTS, codePointLength, isNonBlankPythonText } from '../domain/limits';
import { VisionTextSource } from './documentSource';
import { canonicalizeLocalFileUri } from './tempFileRegistry';

type NativeVisionResult = Readonly<{
  text: string;
  pageCount: number;
}>;

type NativeVisionModule = Readonly<{
  extractTextFromPdf(uri: string): Promise<NativeVisionResult>;
}>;

type VisionAdapterOptions = Readonly<{
  lookup?: () => NativeVisionModule | null;
}>;

export class VisionUnavailableError extends Error {
  readonly category = 'unsupported_pdf' as const;
  readonly developmentBuildRequired: boolean;
  readonly route = 'paste_text' as const;

  constructor(developmentBuildRequired: boolean) {
    super('This PDF needs reviewed text before it can be analyzed.');
    this.name = 'VisionUnavailableError';
    this.developmentBuildRequired = developmentBuildRequired;
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

  constructor(options: VisionAdapterOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup;
  }

  private module(): NativeVisionModule | null {
    try {
      const candidate = this.lookup();
      return candidate !== null && typeof candidate.extractTextFromPdf === 'function'
        ? candidate
        : null;
    } catch {
      return null;
    }
  }

  isAvailable(): boolean {
    return this.module() !== null;
  }

  async extractReviewedText(uri: string): Promise<VisionTextSource> {
    const nativeModule = this.module();
    if (nativeModule === null) throw new VisionUnavailableError(true);

    let canonicalUri: string;
    try {
      canonicalUri = canonicalizeLocalFileUri(uri).uri;
    } catch {
      throw new VisionUnavailableError(false);
    }

    let result: NativeVisionResult;
    try {
      result = await nativeModule.extractTextFromPdf(canonicalUri);
    } catch {
      throw new VisionUnavailableError(false);
    }
    if (
      typeof result?.text !== 'string' ||
      result.text.includes('\0') ||
      !isNonBlankPythonText(result.text) ||
      codePointLength(result.text) > MAX_RESUME_CODE_POINTS ||
      !Number.isSafeInteger(result.pageCount) ||
      result.pageCount <= 0 ||
      result.pageCount > 10
    ) {
      throw new VisionUnavailableError(false);
    }

    return {
      kind: 'vision_text',
      text: result.text,
      reviewed: false,
      pageCount: result.pageCount,
    };
  }
}
