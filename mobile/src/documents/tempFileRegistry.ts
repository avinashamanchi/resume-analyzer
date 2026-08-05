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

export type AbandonedCleanupReceipt = CleanupReceipt & Readonly<{
  deletedFiles: number;
  live: number;
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

type CacheCoordination = {
  tail: Promise<void>;
  readonly liveRequests: Map<string, symbol>;
};

const DEFAULT_FILE_SYSTEM_SCOPE = {};
const CACHE_COORDINATION = new WeakMap<object, Map<string, CacheCoordination>>();

export class DocumentPrivacyError extends Error {
  readonly category = 'privacy' as const;
  readonly code: string;

  constructor(code: string) {
    super('Temporary resume data could not be handled safely.');
    this.name = 'DocumentPrivacyError';
    this.code = code;
  }
}

export class PdfStagingError extends DocumentPrivacyError {
  readonly requestAcquired: boolean;

  constructor(code: string, requestAcquired: boolean) {
    super(code);
    this.name = 'PdfStagingError';
    this.requestAcquired = requestAcquired;
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

function emptyDetailedReceipt(): AbandonedCleanupReceipt {
  return { ...emptyReceipt(), deletedFiles: 0, live: 0 };
}

function coordinationFor(scope: object, namespaceUri: string): CacheCoordination {
  let namespaces = CACHE_COORDINATION.get(scope);
  if (namespaces === undefined) {
    namespaces = new Map();
    CACHE_COORDINATION.set(scope, namespaces);
  }
  let coordination = namespaces.get(namespaceUri);
  if (coordination === undefined) {
    coordination = { tail: Promise.resolve(), liveRequests: new Map() };
    namespaces.set(namespaceUri, coordination);
  }
  return coordination;
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
  private readonly coordination: CacheCoordination;

  constructor(options: TempFileRegistryOptions = {}) {
    this.fileSystem = options.fileSystem ?? new ExpoTempFileSystem();
    const cache = canonicalizeLocalFileUri(this.fileSystem.cacheDirectoryUri);
    this.namespace = appendLocation(cache, TEMP_CACHE_NAMESPACE);
    this.coordination = coordinationFor(
      options.fileSystem ?? DEFAULT_FILE_SYSTEM_SCOPE,
      this.namespace.uri,
    );
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
    return this.enqueueCacheMutation(async () => {
      const owner = await this.acquireRequest(requestId, request);
      try {
        await this.createRequestLocation(request);
        return request.uri;
      } catch (error) {
        this.releaseRequest(requestId, owner);
        throw error;
      }
    });
  }

  async stagePdf(
    requestId: string,
    fileId: string,
    providerUri: string,
  ): Promise<{ uri: string; inspection: FileInspection }> {
    const source = this.validateProviderFileUri(providerUri);
    const destination = this.fileLocation(requestId, fileId);
    return this.enqueueCacheMutation(async () => {
      const request = this.requestLocation(requestId);
      const owner = await this.acquireRequest(requestId, request);
      try {
        await this.createRequestLocation(request);
        await this.fileSystem.copyFile(source, destination.uri);
        const inspection = await this.fileSystem.inspectFile(destination.uri);
        return { uri: destination.uri, inspection };
      } catch {
        this.releaseRequest(requestId, owner);
        throw new PdfStagingError('pdf_staging_failed', true);
      }
    });
  }

  async cleanupRequest(requestId: string): Promise<CleanupReceipt> {
    const request = this.requestLocation(requestId);
    return this.enqueueCacheMutation(async () => {
      try {
        return await this.cleanupRequestLocation(request);
      } finally {
        // cleanupRequest is a terminal ownership handoff. A failed delete must
        // remain discoverable by later abandoned cleanup, not permanently live.
        this.coordination.liveRequests.delete(requestId);
      }
    });
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
    const detailed = await this.cleanupAbandonedDetailed();
    return {
      attempted: detailed.attempted,
      deleted: detailed.deleted,
      failed: detailed.failed,
      refused: detailed.refused + detailed.live,
    };
  }

  async cleanupAbandonedDetailed(): Promise<AbandonedCleanupReceipt> {
    return this.enqueueCacheMutation(() => this.cleanupAbandonedUnfenced());
  }

  private async cleanupAbandonedUnfenced(): Promise<AbandonedCleanupReceipt> {
    let namespaceExists: boolean;
    try {
      namespaceExists = await this.fileSystem.directoryExists(this.namespace.uri);
    } catch {
      return { ...emptyDetailedReceipt(), failed: 1 };
    }
    if (!namespaceExists) return emptyDetailedReceipt();

    let entries: readonly DirectoryEntry[];
    try {
      entries = await this.fileSystem.listDirectory(this.namespace.uri);
    } catch {
      return { ...emptyDetailedReceipt(), failed: 1 };
    }

    let attempted = 0;
    let deleted = 0;
    let failed = 0;
    let refused = 0;
    let deletedFiles = 0;
    let live = 0;
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

      if (this.coordination.liveRequests.has(requestId)) {
        live += 1;
        continue;
      }

      attempted += 1;
      let children: readonly DirectoryEntry[];
      try {
        children = await this.fileSystem.listDirectory(location.uri);
      } catch {
        failed += 1;
        continue;
      }

      const uniqueChildren = new Set<string>();
      let childrenAreOwnedPdfs = true;
      for (const child of children) {
        let childLocation: LocalFileLocation;
        try {
          childLocation = canonicalizeLocalFileUri(child.uri);
        } catch {
          refused += 1;
          childrenAreOwnedPdfs = false;
          continue;
        }
        const filename = childLocation.segments[location.segments.length];
        const fileId = filename?.endsWith('.pdf') ? filename.slice(0, -4) : '';
        if (
          child.kind !== 'file' ||
          !isDirectChild(location, childLocation) ||
          !FILE_ID_PATTERN.test(fileId) ||
          uniqueChildren.has(childLocation.uri)
        ) {
          refused += 1;
          childrenAreOwnedPdfs = false;
          continue;
        }
        uniqueChildren.add(childLocation.uri);
      }
      if (!childrenAreOwnedPdfs) continue;

      try {
        await this.fileSystem.deleteDirectory(location.uri);
        if (await this.fileSystem.directoryExists(location.uri)) {
          failed += 1;
        } else {
          deleted += 1;
          deletedFiles += uniqueChildren.size;
        }
      } catch {
        failed += 1;
      }
    }
    return { attempted, deleted, failed, refused, deletedFiles, live };
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

  private async createRequestLocation(request: LocalFileLocation): Promise<void> {
    await this.fileSystem.createDirectory(this.namespace.uri);
    await this.fileSystem.createDirectory(request.uri);
  }

  private async acquireRequest(
    requestId: string,
    request: LocalFileLocation,
  ): Promise<symbol> {
    // This check must remain the first operation inside the shared mutation
    // fence so a colliding caller cannot touch files owned by the live caller.
    if (this.coordination.liveRequests.has(requestId)) {
      throw new PdfStagingError('cache_request_in_use', false);
    }

    let exists: boolean;
    try {
      exists = await this.fileSystem.directoryExists(request.uri);
    } catch {
      throw new PdfStagingError('cache_request_state_unavailable', false);
    }
    if (exists) {
      // A directory without a live owner is quarantined for abandoned cleanup.
      // Reusing it could combine a new source with bytes from a failed stage.
      throw new PdfStagingError('cache_request_recovery_required', false);
    }

    const owner = Symbol(requestId);
    this.coordination.liveRequests.set(requestId, owner);
    return owner;
  }

  private releaseRequest(requestId: string, owner: symbol): void {
    if (this.coordination.liveRequests.get(requestId) === owner) {
      this.coordination.liveRequests.delete(requestId);
    }
  }

  private enqueueCacheMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.coordination.tail.then(operation);
    this.coordination.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
