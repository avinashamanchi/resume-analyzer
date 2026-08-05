import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { uuid } from 'expo-modules-core';

import {
  MAX_PDF_BYTES,
  MAX_RESUME_CODE_POINTS,
  codePointLength,
  isNonBlankPythonText,
} from '../domain/limits';
import {
  DocumentPrivacyError,
  PdfStagingError,
  TempFileRegistry,
  canonicalizeLocalFileUri,
  isDirectLocalFileChild,
} from './tempFileRegistry';

export type PdfSource = Readonly<{
  kind: 'pdf';
  requestId: string;
  uri: string;
  size: number;
}>;

export type TextSource = Readonly<{
  kind: 'text';
  text: string;
}>;

export type VisionTextSource = Readonly<{
  kind: 'vision_text';
  text: string;
  reviewed: boolean;
  pageCount?: number;
}>;

export type ResumeSource = PdfSource | TextSource | VisionTextSource;

type DocumentSourceErrorCategory = 'validation' | 'privacy';

const DOCUMENT_ERROR_MESSAGES: Readonly<Record<DocumentSourceErrorCategory, string>> = {
  validation: 'The selected material is not supported.',
  privacy: 'Temporary resume data could not be removed safely.',
};

export class DocumentSourceError extends Error {
  readonly category: DocumentSourceErrorCategory;
  readonly code: string;

  constructor(category: DocumentSourceErrorCategory, code: string) {
    super(DOCUMENT_ERROR_MESSAGES[category]);
    this.name = 'DocumentSourceError';
    this.category = category;
    this.code = code;
  }
}

type PickerAsset = Readonly<{
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  uri?: unknown;
}>;

type PickerResult =
  | Readonly<{ canceled: true; assets: null }>
  | Readonly<{ canceled: false; assets: readonly PickerAsset[] }>;

type PickerPort = Readonly<{
  pick(options: {
    type: 'application/pdf';
    copyToCacheDirectory: true;
    multiple: false;
  }): Promise<PickerResult>;
  release(uri: string): Promise<void>;
}>;

type DocumentSourceServiceOptions = Readonly<{
  picker?: PickerPort;
  registry?: TempFileRegistry;
  requestId?: () => string;
  fileId?: () => string;
}>;

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

function randomUuid(): string {
  let value: string;
  try {
    value = uuid.v4();
  } catch {
    throw new DocumentSourceError('privacy', 'secure_random_unavailable');
  }
  return value.toLowerCase();
}

function asValidationError(code: string): DocumentSourceError {
  return new DocumentSourceError('validation', code);
}

const expoPicker: PickerPort = {
  pick: options => DocumentPicker.getDocumentAsync(options) as Promise<PickerResult>,
  async release(uri: string): Promise<void> {
    const canonicalUri = canonicalizeLocalFileUri(uri).uri;
    const providerDirectory = new Directory(Paths.cache, 'DocumentPicker').uri;
    if (!isDirectLocalFileChild(providerDirectory, canonicalUri)) {
      throw new DocumentSourceError('privacy', 'provider_outside_picker_cache');
    }
    const file = new File(canonicalUri);
    if (!file.exists) return;
    file.delete();
    if (file.exists) {
      throw new DocumentSourceError('privacy', 'provider_cleanup_failed');
    }
  },
};

function selectedUris(result: PickerResult): string[] {
  if (!Array.isArray(result.assets)) return [];
  return [
    ...new Set(
      result.assets
        .map(asset =>
          typeof asset === 'object' && asset !== null && typeof asset.uri === 'string'
            ? asset.uri
            : null,
        )
        .filter((uri): uri is string => uri !== null),
    ),
  ];
}

function validateAssetShape(asset: PickerAsset, registry: TempFileRegistry): {
  size: number;
  providerUri: string;
} {
  if (
    typeof asset !== 'object' ||
    asset === null ||
    typeof asset.name !== 'string' ||
    asset.name.includes('/') ||
    asset.name.includes('\\') ||
    asset.name.includes('\0') ||
    !/\.pdf$/i.test(asset.name)
  ) {
    throw asValidationError('invalid_pdf_name');
  }
  if (asset.mimeType !== 'application/pdf') {
    throw asValidationError('invalid_pdf_mime');
  }
  if (
    typeof asset.size !== 'number' ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_PDF_BYTES
  ) {
    throw asValidationError('invalid_pdf_size');
  }

  let providerUri: string;
  try {
    providerUri = registry.validateProviderFileUri(asset.uri);
  } catch {
    throw asValidationError('invalid_pdf_uri');
  }
  return { size: asset.size, providerUri };
}

function isPdfHeader(header: Uint8Array): boolean {
  return PDF_HEADER.every((byte, index) => header[index] === byte);
}

export class DocumentSourceService {
  private readonly picker: PickerPort;
  private readonly registry: TempFileRegistry;
  private readonly requestId: () => string;
  private readonly fileId: () => string;

  constructor(options: DocumentSourceServiceOptions = {}) {
    this.picker = options.picker ?? expoPicker;
    this.registry = options.registry ?? new TempFileRegistry();
    this.requestId = options.requestId ?? randomUuid;
    this.fileId = options.fileId ?? randomUuid;
  }

  async pickPdf(): Promise<PdfSource | null> {
    let result: PickerResult;
    try {
      result = await this.picker.pick({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch {
      throw asValidationError('picker_failed');
    }

    if (result?.canceled === true && result.assets === null) return null;
    const providerUris = selectedUris(result);
    let requestId: string | null = null;
    let requestAcquired = false;
    try {
      if (result?.canceled !== false || !Array.isArray(result.assets) || result.assets.length !== 1) {
        throw asValidationError('invalid_picker_result');
      }

      const selected = validateAssetShape(result.assets[0], this.registry);
      let fileId: string;
      try {
        requestId = this.registry.validateRequestId(this.requestId());
        fileId = this.registry.validateFileId(this.fileId());
      } catch {
        throw new DocumentSourceError('privacy', 'invalid_cache_identifier');
      }

      try {
        let staged;
        try {
          staged = await this.registry.stagePdf(
            requestId,
            fileId,
            selected.providerUri,
          );
          requestAcquired = true;
        } catch (error) {
          if (error instanceof PdfStagingError) {
            requestAcquired = error.requestAcquired;
          }
          throw error;
        }
        const { inspection } = staged;
        if (
          !inspection.exists ||
          !Number.isSafeInteger(inspection.size) ||
          inspection.size <= 0 ||
          inspection.size > MAX_PDF_BYTES ||
          inspection.size !== selected.size ||
          !isPdfHeader(inspection.header)
        ) {
          throw asValidationError('invalid_copied_pdf');
        }
        return {
          kind: 'pdf',
          requestId,
          uri: staged.uri,
          size: inspection.size,
        };
      } catch (error) {
        if (requestAcquired) {
          const receipt = await this.registry.cleanupRequest(requestId);
          requestAcquired = false;
          if (receipt.failed > 0 || receipt.deleted !== receipt.attempted) {
            throw new DocumentSourceError('privacy', 'cache_cleanup_failed');
          }
        }
        if (error instanceof PdfStagingError) {
          if (!error.requestAcquired) {
            throw new DocumentSourceError('privacy', error.code);
          }
          throw asValidationError('pdf_staging_failed');
        }
        if (error instanceof DocumentPrivacyError) {
          throw new DocumentSourceError('privacy', error.code);
        }
        throw asValidationError('pdf_staging_failed');
      }
    } finally {
      let releaseFailed = false;
      for (const providerUri of providerUris) {
        try {
          await this.picker.release(providerUri);
        } catch {
          releaseFailed = true;
        }
      }
      if (releaseFailed) {
        if (requestId !== null && requestAcquired) {
          const receipt = await this.registry.cleanupRequest(requestId);
          requestAcquired = false;
          if (receipt.failed > 0 || receipt.deleted !== receipt.attempted) {
            throw new DocumentSourceError('privacy', 'cache_cleanup_failed');
          }
        }
        throw new DocumentSourceError('privacy', 'provider_cleanup_failed');
      }
    }
  }
}

export function createPastedTextSource(text: unknown): TextSource {
  if (typeof text !== 'string' || text.includes('\0')) {
    throw asValidationError('invalid_pasted_text');
  }
  const normalized = text.replace(/\r\n/g, '\n');
  if (
    !isNonBlankPythonText(normalized) ||
    codePointLength(normalized) > MAX_RESUME_CODE_POINTS
  ) {
    throw asValidationError('invalid_pasted_text');
  }
  return { kind: 'text', text: normalized };
}
