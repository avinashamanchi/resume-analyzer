import { Directory, File, FileMode, Paths } from 'expo-file-system';

export const TEMP_CACHE_NAMESPACE = 'resume-ai-v1';

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE_ID_PATTERN = REQUEST_ID_PATTERN;
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c)/i;

export type CleanupReceipt = Readonly<{
  attempted: number;
  deleted: number;
  failed: number;
  refused: number;
}>;

export type FileInspection = Readonly<{
  exists: boolean;
  size: number;
  header: Uint8Array;
}>;

export type OwnedFileInspection = Readonly<{
  requestId: string;
  uri: string;
  exists: boolean;
  size: number;
}>;

export type DirectoryEntry = Readonly<{
  uri: string;
  kind: 'file' | 'directory';
}>;

export interface TempFileSystem {
  readonly cacheDirectoryUri: string;
  createDirectory(uri: string): Promise<void>;
  directoryExists(uri: string): Promise<boolean>;
  listDirectory(uri: string): Promise<readonly DirectoryEntry[]>;
  copyFile(source: string, destination: string): Promise<void>;
  inspectFile(uri: string): Promise<FileInspection>;
  deleteDirectory(uri: string): Promise<void>;
}

type LocalFileLocation = Readonly<{
  uri: string;
  path: string;
  segments: readonly string[];
}>;

export class DocumentPrivacyError extends Error {
  readonly category = 'privacy' as const;
  readonly code: string;

  constructor(code: string) {
    super('Temporary resume data could not be handled safely.');
    this.name = 'DocumentPrivacyError';
    this.code = code;
  }
}

function privacyError(code: string): DocumentPrivacyError {
  return new DocumentPrivacyError(code);
}

function encodePath(segments: readonly string[]): string {
  return `/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
}

export function canonicalizeLocalFileUri(value: unknown): LocalFileLocation {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw privacyError('invalid_file_uri');
  }
  if (value.includes('?') || value.includes('#') || ENCODED_SEPARATOR_PATTERN.test(value)) {
    throw privacyError('invalid_file_uri');
  }

  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(value);
  if (match === null || match[1] !== '') throw privacyError('invalid_file_uri');

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(match[2]);
  } catch {
    throw privacyError('invalid_file_uri');
  }
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    throw privacyError('invalid_file_uri');
  }

  const rawSegments = decodedPath.split('/');
  if (rawSegments.some(segment => segment === '.' || segment === '..')) {
    throw privacyError('invalid_file_uri');
  }
  const segments = rawSegments.filter(segment => segment.length > 0);
  const path = encodePath(segments);
  return { uri: `file://${path}`, path, segments };
}

function appendLocation(parent: LocalFileLocation, ...segments: string[]): LocalFileLocation {
  if (segments.some(segment => segment.length === 0 || segment.includes('/') || segment.includes('\\'))) {
    throw privacyError('invalid_cache_descendant');
  }
  const allSegments = [...parent.segments, ...segments];
  const path = encodePath(allSegments);
  return { uri: `file://${path}`, path, segments: allSegments };
}

function isDirectChild(parent: LocalFileLocation, child: LocalFileLocation): boolean {
  if (child.segments.length !== parent.segments.length + 1) return false;
  return parent.segments.every((segment, index) => segment === child.segments[index]);
}

export function isDirectLocalFileChild(parentUri: unknown, childUri: unknown): boolean {
  try {
    return isDirectChild(
      canonicalizeLocalFileUri(parentUri),
      canonicalizeLocalFileUri(childUri),
    );
  } catch {
    return false;
  }
}

function emptyReceipt(): CleanupReceipt {
  return { attempted: 0, deleted: 0, failed: 0, refused: 0 };
}

class ExpoTempFileSystem implements TempFileSystem {
  get cacheDirectoryUri(): string {
    return Paths.cache.uri;
  }

  async createDirectory(uri: string): Promise<void> {
    new Directory(uri).create({ idempotent: true, intermediates: true });
  }

  async directoryExists(uri: string): Promise<boolean> {
    return new Directory(uri).exists;
  }

  async listDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    return new Directory(uri).list().map(entry => ({
      uri: entry.uri,
      kind: entry instanceof Directory ? 'directory' : 'file',
    }));
  }

  async copyFile(source: string, destination: string): Promise<void> {
    await new File(source).copy(new File(destination));
  }

  async inspectFile(uri: string): Promise<FileInspection> {
    const file = new File(uri);
    if (!file.exists) return { exists: false, size: 0, header: new Uint8Array() };

    const size = file.size;
    const handle = file.open(FileMode.ReadOnly);
    try {
      return { exists: true, size, header: handle.readBytes(5) };
    } finally {
      handle.close();
    }
  }

  async deleteDirectory(uri: string): Promise<void> {
    const directory = new Directory(uri);
    if (directory.exists) directory.delete();
  }
}

export type TempFileRegistryOptions = Readonly<{
  fileSystem?: TempFileSystem;
}>;

export class TempFileRegistry {
  private readonly fileSystem: TempFileSystem;
  private readonly namespace: LocalFileLocation;
  private readonly cleanupOperations = new Map<string, Promise<CleanupReceipt>>();

  constructor(options: TempFileRegistryOptions = {}) {
    this.fileSystem = options.fileSystem ?? new ExpoTempFileSystem();
    const cache = canonicalizeLocalFileUri(this.fileSystem.cacheDirectoryUri);
    this.namespace = appendLocation(cache, TEMP_CACHE_NAMESPACE);
  }

  private requestLocation(requestId: string): LocalFileLocation {
    this.validateRequestId(requestId);
    return appendLocation(this.namespace, requestId);
  }

  private fileLocation(requestId: string, fileId: string): LocalFileLocation {
    this.validateFileId(fileId);
    return appendLocation(this.requestLocation(requestId), `${fileId}.pdf`);
  }

  validateRequestId(value: unknown): string {
    if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
      throw privacyError('invalid_request_id');
    }
    return value;
  }

  validateFileId(value: unknown): string {
    if (typeof value !== 'string' || !FILE_ID_PATTERN.test(value)) {
      throw privacyError('invalid_file_id');
    }
    return value;
  }

  validateProviderFileUri(uri: unknown): string {
    return canonicalizeLocalFileUri(uri).uri;
  }

  assertOwnedFileUri(uri: unknown): { requestId: string; uri: string } {
    const location = canonicalizeLocalFileUri(uri);
    if (location.segments.length !== this.namespace.segments.length + 2) {
      throw privacyError('file_outside_cache_namespace');
    }
    if (!this.namespace.segments.every((segment, index) => location.segments[index] === segment)) {
      throw privacyError('file_outside_cache_namespace');
    }

    const requestId = location.segments[this.namespace.segments.length];
    const filename = location.segments[this.namespace.segments.length + 1];
    if (!REQUEST_ID_PATTERN.test(requestId) || !filename.endsWith('.pdf')) {
      throw privacyError('invalid_cache_file');
    }
    const fileId = filename.slice(0, -4);
    if (!FILE_ID_PATTERN.test(fileId)) throw privacyError('invalid_cache_file');
    return { requestId, uri: location.uri };
  }

  async inspectOwnedFileUri(uri: unknown): Promise<OwnedFileInspection> {
    const owned = this.assertOwnedFileUri(uri);
    let inspection: FileInspection;
    try {
      inspection = await this.fileSystem.inspectFile(owned.uri);
    } catch {
      throw privacyError('cache_file_inspection_failed');
    }
    if (
      inspection === null ||
      typeof inspection !== 'object' ||
      typeof inspection.exists !== 'boolean' ||
      !Number.isSafeInteger(inspection.size) ||
      inspection.size < 0
    ) {
      throw privacyError('cache_file_inspection_failed');
    }
    return {
      requestId: owned.requestId,
      uri: owned.uri,
      exists: inspection.exists,
      size: inspection.size,
    };
  }

  async createRequest(requestId: string): Promise<string> {
    const request = this.requestLocation(requestId);
    await this.fileSystem.createDirectory(this.namespace.uri);
    await this.fileSystem.createDirectory(request.uri);
    return request.uri;
  }

  async stagePdf(
    requestId: string,
    fileId: string,
    providerUri: string,
  ): Promise<{ uri: string; inspection: FileInspection }> {
    const source = this.validateProviderFileUri(providerUri);
    const destination = this.fileLocation(requestId, fileId);
    await this.createRequest(requestId);
    await this.fileSystem.copyFile(source, destination.uri);
    const inspection = await this.fileSystem.inspectFile(destination.uri);
    return { uri: destination.uri, inspection };
  }

  async cleanupRequest(requestId: string): Promise<CleanupReceipt> {
    const request = this.requestLocation(requestId);
    const previous = this.cleanupOperations.get(requestId);
    const operation = (previous ?? Promise.resolve(emptyReceipt()))
      .catch(() => emptyReceipt())
      .then(() => this.cleanupRequestLocation(request));
    this.cleanupOperations.set(requestId, operation);
    try {
      return await operation;
    } finally {
      if (this.cleanupOperations.get(requestId) === operation) {
        this.cleanupOperations.delete(requestId);
      }
    }
  }

  private async cleanupRequestLocation(request: LocalFileLocation): Promise<CleanupReceipt> {
    let exists: boolean;
    try {
      exists = await this.fileSystem.directoryExists(request.uri);
    } catch {
      return { attempted: 0, deleted: 0, failed: 1, refused: 0 };
    }
    if (!exists) return emptyReceipt();

    try {
      await this.fileSystem.deleteDirectory(request.uri);
      const remains = await this.fileSystem.directoryExists(request.uri);
      return remains
        ? { attempted: 1, deleted: 0, failed: 1, refused: 0 }
        : { attempted: 1, deleted: 1, failed: 0, refused: 0 };
    } catch {
      return { attempted: 1, deleted: 0, failed: 1, refused: 0 };
    }
  }

  async cleanupAbandoned(): Promise<CleanupReceipt> {
    let namespaceExists: boolean;
    try {
      namespaceExists = await this.fileSystem.directoryExists(this.namespace.uri);
    } catch {
      return { attempted: 0, deleted: 0, failed: 1, refused: 0 };
    }
    if (!namespaceExists) return emptyReceipt();

    let entries: readonly DirectoryEntry[];
    try {
      entries = await this.fileSystem.listDirectory(this.namespace.uri);
    } catch {
      return { attempted: 0, deleted: 0, failed: 1, refused: 0 };
    }

    let attempted = 0;
    let deleted = 0;
    let failed = 0;
    let refused = 0;
    for (const entry of entries) {
      let location: LocalFileLocation;
      try {
        location = canonicalizeLocalFileUri(entry.uri);
      } catch {
        refused += 1;
        continue;
      }
      const requestId = location.segments[this.namespace.segments.length];
      if (
        entry.kind !== 'directory' ||
        !isDirectChild(this.namespace, location) ||
        !REQUEST_ID_PATTERN.test(requestId ?? '')
      ) {
        refused += 1;
        continue;
      }

      attempted += 1;
      try {
        await this.fileSystem.deleteDirectory(location.uri);
        if (await this.fileSystem.directoryExists(location.uri)) failed += 1;
        else deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { attempted, deleted, failed, refused };
  }

  async withRequestCleanup<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      const receipt = await this.cleanupRequest(requestId);
      if (receipt.failed > 0 || receipt.deleted !== receipt.attempted) {
        throw privacyError('cache_cleanup_failed');
      }
    }
  }
}
