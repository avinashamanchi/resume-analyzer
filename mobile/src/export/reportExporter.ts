import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import {
  canonicalizeLocalFileUri,
  isDirectLocalFileChild,
} from '../documents/tempFileRegistry';
import {
  ReportRecordSchema,
  type ReportRecord,
} from '../storage/reportRepository';
import { buildReportHtml } from './reportHtml';

const PRINT_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;

export type ExportReceipt = Readonly<{ numberOfPages: number }>;

export type ReportExportErrorCode =
  | 'invalid_report'
  | 'render_failed'
  | 'invalid_output'
  | 'invalid_receipt'
  | 'share_cancelled'
  | 'sharing_unavailable'
  | 'share_failed'
  | 'cleanup_failed';

const PUBLIC_MESSAGES: Readonly<Record<ReportExportErrorCode, string>> = {
  invalid_report: 'The report could not be prepared for export.',
  render_failed: 'The PDF report could not be created.',
  invalid_output: 'The PDF report could not be verified.',
  invalid_receipt: 'The PDF report is no longer available.',
  share_cancelled: 'The PDF share was cancelled.',
  sharing_unavailable: 'File sharing is not available on this device.',
  share_failed: 'The PDF report was not shared.',
  cleanup_failed: 'The temporary PDF could not be verified as removed.',
};

export class ReportExportError extends Error {
  readonly category = 'report_export' as const;
  readonly code: ReportExportErrorCode;

  constructor(code: ReportExportErrorCode) {
    super(PUBLIC_MESSAGES[code]);
    this.name = 'ReportExportError';
    this.code = code;
  }
}

export type ReportDirectoryEntry = Readonly<{
  uri: string;
  kind: 'file' | 'directory';
}>;

export interface ReportFileSystem {
  readonly cacheDirectoryUri: string;
  directoryExists(uri: string): Promise<boolean>;
  listDirectory(uri: string): Promise<readonly ReportDirectoryEntry[]>;
  fileExists(uri: string): Promise<boolean>;
  deleteFile(uri: string): Promise<void>;
}

class ExpoReportFileSystem implements ReportFileSystem {
  get cacheDirectoryUri(): string { return Paths.cache.uri; }

  async directoryExists(uri: string): Promise<boolean> {
    return new Directory(uri).exists;
  }

  async listDirectory(uri: string): Promise<readonly ReportDirectoryEntry[]> {
    return new Directory(uri).list().map(entry => ({
      uri: entry.uri,
      kind: entry instanceof Directory ? 'directory' : 'file',
    }));
  }

  async fileExists(uri: string): Promise<boolean> {
    return new File(uri).exists;
  }

  async deleteFile(uri: string): Promise<void> {
    const file = new File(uri);
    if (file.exists) file.delete();
  }
}

export interface OwnedReportFiles {
  owns(uri: string): boolean;
  cleanupAbandoned(protectedUris: readonly string[]): Promise<number>;
  delete(uri: string): Promise<void>;
}

export class ReportFileStore implements OwnedReportFiles {
  private readonly fileSystem: ReportFileSystem;
  private readonly printDirectoryUri: string;

  constructor(options: Readonly<{ fileSystem?: ReportFileSystem }> = {}) {
    this.fileSystem = options.fileSystem ?? new ExpoReportFileSystem();
    const cache = canonicalizeLocalFileUri(this.fileSystem.cacheDirectoryUri).uri;
    this.printDirectoryUri = canonicalizeLocalFileUri(
      `${cache.replace(/\/$/, '')}/Print`,
    ).uri;
  }

  owns(uri: string): boolean {
    try {
      const canonical = canonicalizeLocalFileUri(uri).uri;
      const name = canonical.slice(canonical.lastIndexOf('/') + 1);
      return PRINT_FILE.test(name) && isDirectLocalFileChild(this.printDirectoryUri, canonical);
    } catch {
      return false;
    }
  }

  async cleanupAbandoned(protectedUris: readonly string[]): Promise<number> {
    if (!(await this.fileSystem.directoryExists(this.printDirectoryUri))) return 0;
    const protectedSet = new Set(
      protectedUris
        .filter(uri => this.owns(uri))
        .map(uri => canonicalizeLocalFileUri(uri).uri),
    );
    const entries = await this.fileSystem.listDirectory(this.printDirectoryUri);
    let deleted = 0;
    for (const entry of entries) {
      if (entry.kind !== 'file' || !this.owns(entry.uri)) continue;
      const uri = canonicalizeLocalFileUri(entry.uri).uri;
      if (protectedSet.has(uri)) continue;
      await this.delete(uri);
      deleted += 1;
    }
    return deleted;
  }

  async delete(uri: string): Promise<void> {
    if (!this.owns(uri)) throw new Error('Report file ownership could not be verified.');
    const canonical = canonicalizeLocalFileUri(uri).uri;
    if (!(await this.fileSystem.fileExists(canonical))) return;
    await this.fileSystem.deleteFile(canonical);
    if (await this.fileSystem.fileExists(canonical)) {
      throw new Error('Report file cleanup could not be verified.');
    }
  }
}

type ReportPrintPort = Readonly<{
  printToFileAsync(options: Readonly<{
    html: string;
    base64: false;
    margins: Readonly<{ top: number; right: number; bottom: number; left: number }>;
  }>): Promise<Readonly<{ uri: string; numberOfPages: number }>>;
}>;

type ReportSharingPort = Readonly<{
  isAvailableAsync(): Promise<boolean>;
  shareAsync(uri: string, options: Readonly<{ UTI: string; mimeType: string }>): Promise<void>;
}>;

export type ReportExporterOptions = Readonly<{
  print?: ReportPrintPort;
  sharing?: ReportSharingPort;
  files?: OwnedReportFiles;
}>;

export interface ReportExporterPort {
  cleanupAbandoned(): Promise<number>;
  export(report: ReportRecord): Promise<ExportReceipt>;
  share(receipt: ExportReceipt, lifecycle: AbortSignal): Promise<void>;
  discard(receipt: ExportReceipt): Promise<void>;
}

const expoPrint: ReportPrintPort = {
  printToFileAsync: options => Print.printToFileAsync(options),
};

const expoSharing: ReportSharingPort = {
  isAvailableAsync: () => Sharing.isAvailableAsync(),
  shareAsync: (uri, options) => Sharing.shareAsync(uri, options),
};

export class ReportExporter implements ReportExporterPort {
  private readonly print: ReportPrintPort;
  private readonly sharing: ReportSharingPort;
  private readonly files: OwnedReportFiles;
  private readonly receipts = new WeakMap<ExportReceipt, string>();
  private readonly activeUris = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: ReportExporterOptions = {}) {
    this.print = options.print ?? expoPrint;
    this.sharing = options.sharing ?? expoSharing;
    this.files = options.files ?? new ReportFileStore();
  }

  cleanupAbandoned(): Promise<number> {
    return this.enqueue(async () => {
      try {
        return await this.files.cleanupAbandoned([...this.activeUris]);
      } catch {
        throw new ReportExportError('cleanup_failed');
      }
    });
  }

  export(report: ReportRecord): Promise<ExportReceipt> {
    return this.enqueue(async () => {
      const parsed = ReportRecordSchema.safeParse(report);
      if (!parsed.success) throw new ReportExportError('invalid_report');
      try {
        await this.files.cleanupAbandoned([...this.activeUris]);
      } catch {
        throw new ReportExportError('cleanup_failed');
      }

      let output: Readonly<{ uri: string; numberOfPages: number }>;
      try {
        output = await this.print.printToFileAsync({
          html: buildReportHtml(parsed.data),
          base64: false,
          margins: { top: 44, right: 44, bottom: 44, left: 44 },
        });
      } catch {
        throw new ReportExportError('render_failed');
      }

      const owned = typeof output?.uri === 'string' && this.files.owns(output.uri);
      const validPages = Number.isSafeInteger(output?.numberOfPages) &&
        output.numberOfPages >= 1 && output.numberOfPages <= 1_000;
      if (!owned || !validPages) {
        if (owned) {
          try {
            await this.files.delete(output.uri);
          } catch {
            throw new ReportExportError('cleanup_failed');
          }
        }
        throw new ReportExportError('invalid_output');
      }

      const receipt = Object.freeze({ numberOfPages: output.numberOfPages });
      this.receipts.set(receipt, output.uri);
      this.activeUris.add(output.uri);
      return receipt;
    });
  }

  share(receipt: ExportReceipt, lifecycle: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      const uri = this.receipts.get(receipt);
      if (uri === undefined) throw new ReportExportError('invalid_receipt');
      this.receipts.delete(receipt);
      this.activeUris.delete(uri);

      let shareFailure: ReportExportError | null = null;
      if (lifecycle.aborted) {
        shareFailure = new ReportExportError('share_cancelled');
      } else {
        try {
          const available = await this.sharing.isAvailableAsync();
          if (lifecycle.aborted) {
            shareFailure = new ReportExportError('share_cancelled');
          } else if (!available) {
            shareFailure = new ReportExportError('sharing_unavailable');
          } else {
            await this.sharing.shareAsync(uri, {
              UTI: 'com.adobe.pdf',
              mimeType: 'application/pdf',
            });
          }
        } catch {
          shareFailure = new ReportExportError('share_failed');
        }
      }

      try {
        await this.files.delete(uri);
      } catch {
        throw new ReportExportError('cleanup_failed');
      }
      if (shareFailure !== null) throw shareFailure;
    });
  }

  discard(receipt: ExportReceipt): Promise<void> {
    return this.enqueue(async () => {
      const uri = this.receipts.get(receipt);
      if (uri === undefined) throw new ReportExportError('invalid_receipt');
      this.receipts.delete(receipt);
      this.activeUris.delete(uri);
      try {
        await this.files.delete(uri);
      } catch {
        throw new ReportExportError('cleanup_failed');
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export const reportExporter = new ReportExporter();
