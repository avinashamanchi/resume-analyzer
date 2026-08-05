import {
  AbandonedCleanupReceipt,
  CleanupReceipt,
  FileInspection,
  TempFileRegistry,
  TempFileSystem,
} from '../src/documents/tempFileRegistry';

const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FILE_A = '11111111-1111-4111-8111-111111111111';
const FILE_B = '22222222-2222-4222-8222-222222222222';
const NAMESPACE_URI = 'file:///app/cache/resume-ai-v1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

function cleanupDetailed(registry: TempFileRegistry): Promise<AbandonedCleanupReceipt> {
  return registry.cleanupAbandonedDetailed();
}

class RegistryFileSystem implements TempFileSystem {
  readonly cacheDirectoryUri = 'file:///app/cache/';
  readonly directories = new Set<string>();
  entries: Array<{ uri: string; kind: 'file' | 'directory' }> = [];
  entriesByDirectory = new Map<string, Array<{ uri: string; kind: 'file' | 'directory' }>>();
  deleteFailures = new Set<string>();
  deleted: string[] = [];
  inspected: string[] = [];
  inspection: FileInspection = {
    exists: true,
    size: 1,
    header: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
  };
  listFailure = false;
  deleteNoop = false;
  inspectFailure = false;

  async createDirectory(uri: string): Promise<void> {
    this.directories.add(uri);
    if (uri.startsWith(`${NAMESPACE_URI}/`) && !uri.slice(NAMESPACE_URI.length + 1).includes('/')) {
      const entries = this.entriesByDirectory.get(NAMESPACE_URI) ?? [];
      if (!entries.some(entry => entry.uri === uri)) {
        this.entriesByDirectory.set(NAMESPACE_URI, [
          ...entries,
          { uri, kind: 'directory' },
        ]);
      }
    }
  }

  async directoryExists(uri: string): Promise<boolean> {
    return this.directories.has(uri);
  }

  async listDirectory(uri: string): Promise<readonly { uri: string; kind: 'file' | 'directory' }[]> {
    if (this.listFailure) throw new Error('private listing details');
    return this.entriesByDirectory.get(uri) ?? this.entries;
  }

  async copyFile(_source: string, destination: string): Promise<void> {
    const separator = destination.lastIndexOf('/');
    const directory = destination.slice(0, separator);
    const entries = this.entriesByDirectory.get(directory) ?? [];
    if (!entries.some(entry => entry.uri === destination)) {
      this.entriesByDirectory.set(directory, [
        ...entries,
        { uri: destination, kind: 'file' },
      ]);
    }
  }

  async inspectFile(uri: string): Promise<FileInspection> {
    this.inspected.push(uri);
    if (this.inspectFailure) throw new Error('private inspection details');
    return this.inspection;
  }

  async deleteDirectory(uri: string): Promise<void> {
    if (this.deleteFailures.has(uri)) throw new Error('private delete details');
    this.deleted.push(uri);
    if (!this.deleteNoop) {
      this.directories.delete(uri);
      this.entriesByDirectory.delete(uri);
      const namespaceEntries = this.entriesByDirectory.get(NAMESPACE_URI);
      if (namespaceEntries !== undefined) {
        this.entriesByDirectory.set(
          NAMESPACE_URI,
          namespaceEntries.filter(entry => entry.uri !== uri),
        );
      }
    }
  }
}

function requestUri(requestId: string): string {
  return `file:///app/cache/resume-ai-v1/${requestId}`;
}

function harness() {
  const fileSystem = new RegistryFileSystem();
  const registry = new TempFileRegistry({ fileSystem });
  return { fileSystem, registry };
}

describe('TempFileRegistry request isolation', () => {
  it('creates only an exact UUID request descendant of the dedicated namespace', async () => {
    const { fileSystem, registry } = harness();

    await expect(registry.createRequest(REQUEST_A)).resolves.toBe(requestUri(REQUEST_A));
    expect([...fileSystem.directories]).toEqual([
      'file:///app/cache/resume-ai-v1',
      requestUri(REQUEST_A),
    ]);
  });

  it.each([
    '../outside',
    '%2e%2e',
    'not-a-request',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/child',
  ])('rejects an invalid request identifier: %s', async requestId => {
    const { fileSystem, registry } = harness();

    await expect(registry.createRequest(requestId)).rejects.toMatchObject({
      category: 'privacy',
    });
    expect(fileSystem.directories.size).toBe(0);
  });

  it.each([
    'https://example.test/resume.pdf',
    'file://host/app/cache/resume-ai-v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file.pdf',
    'file:///app/cache/resume-ai-v1/%2e%2e/outside/file.pdf',
    'file:///app/cache/resume-ai-v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/%2e%2e/file.pdf',
    'file:///app/cache/resume-ai-v1-evil/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file.pdf',
    'file:///app/cache/resume-ai-v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa%2Fother/file.pdf',
    'file:///app/cache/resume-ai-v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file.pdf?secret=1',
  ])('rejects non-owned or ambiguous file URI: %s', uri => {
    const { registry } = harness();
    expect(() => registry.assertOwnedFileUri(uri)).toThrow(
      expect.objectContaining({ category: 'privacy' }),
    );
  });

  it('accepts only an exact generated PDF child', () => {
    const { registry } = harness();
    const uri = `${requestUri(REQUEST_A)}/11111111-1111-4111-8111-111111111111.pdf`;

    expect(registry.assertOwnedFileUri(uri)).toEqual({ requestId: REQUEST_A, uri });
  });

  it('reports live existence and size only after reasserting the exact owned PDF URI', async () => {
    const { fileSystem, registry } = harness();
    const uri = `${requestUri(REQUEST_A)}/11111111-1111-4111-8111-111111111111.pdf`;
    fileSystem.inspection = {
      exists: true,
      size: 4_096,
      header: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    };

    await expect(registry.inspectOwnedFileUri(uri)).resolves.toEqual({
      requestId: REQUEST_A,
      uri,
      exists: true,
      size: 4_096,
    });
    expect(fileSystem.inspected).toEqual([uri]);
  });
});

describe('TempFileRegistry cleanup', () => {
  it('returns a truthful successful receipt and is idempotent', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add(requestUri(REQUEST_A));

    await expect(registry.cleanupRequest(REQUEST_A)).resolves.toEqual<CleanupReceipt>({
      attempted: 1,
      deleted: 1,
      failed: 0,
      refused: 0,
    });
    await expect(registry.cleanupRequest(REQUEST_A)).resolves.toEqual<CleanupReceipt>({
      attempted: 0,
      deleted: 0,
      failed: 0,
      refused: 0,
    });
    expect(fileSystem.deleted).toEqual([requestUri(REQUEST_A)]);
  });

  it('linearizes concurrent cleanup so one directory is never counted as two deletions', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add(requestUri(REQUEST_A));

    const receipts = await Promise.all([
      registry.cleanupRequest(REQUEST_A),
      registry.cleanupRequest(REQUEST_A),
    ]);

    expect(receipts).toEqual([
      { attempted: 1, deleted: 1, failed: 0, refused: 0 },
      { attempted: 0, deleted: 0, failed: 0, refused: 0 },
    ]);
    expect(fileSystem.deleted).toEqual([requestUri(REQUEST_A)]);
  });

  it('counts a rejected deletion as failed and never as deleted', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add(requestUri(REQUEST_A));
    fileSystem.deleteFailures.add(requestUri(REQUEST_A));

    await expect(registry.cleanupRequest(REQUEST_A)).resolves.toEqual<CleanupReceipt>({
      attempted: 1,
      deleted: 0,
      failed: 1,
      refused: 0,
    });
  });

  it('does not claim deletion when the filesystem resolves but the directory remains', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add(requestUri(REQUEST_A));
    fileSystem.deleteNoop = true;

    await expect(registry.cleanupRequest(REQUEST_A)).resolves.toEqual<CleanupReceipt>({
      attempted: 1,
      deleted: 0,
      failed: 1,
      refused: 0,
    });
  });

  it.each(['success', 'failure', 'cancel', 'timeout']) (
    'awaits cleanup when an operation exits through %s',
    async outcome => {
      const { fileSystem, registry } = harness();
      fileSystem.directories.add(requestUri(REQUEST_A));
      const operation = jest.fn(async () => {
        if (outcome !== 'success') throw Object.assign(new Error('content-free'), { category: outcome });
        return 'done';
      });

      const result = registry.withRequestCleanup(REQUEST_A, operation);
      if (outcome === 'success') await expect(result).resolves.toBe('done');
      else await expect(result).rejects.toMatchObject({ category: outcome });
      expect(fileSystem.deleted).toEqual([requestUri(REQUEST_A)]);
    },
  );

  it('fails closed when mandatory finally cleanup rejects', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add(requestUri(REQUEST_A));
    fileSystem.deleteFailures.add(requestUri(REQUEST_A));

    await expect(registry.withRequestCleanup(REQUEST_A, async () => 'done')).rejects.toMatchObject({
      category: 'privacy',
      code: 'cache_cleanup_failed',
    });
  });

  it('cleans only valid abandoned request directories and refuses every unexpected entry', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add('file:///app/cache/resume-ai-v1');
    fileSystem.entriesByDirectory.set(NAMESPACE_URI, [
      { uri: requestUri(REQUEST_A), kind: 'directory' },
      { uri: requestUri(REQUEST_B), kind: 'directory' },
      { uri: 'file:///app/cache/resume-ai-v1/not-a-uuid', kind: 'directory' },
      { uri: 'file:///app/cache/resume-ai-v1/%2e%2e/outside', kind: 'directory' },
      { uri: 'file:///app/cache/resume-ai-v1-evil/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'directory' },
      { uri: `${requestUri(REQUEST_A)}/nested`, kind: 'directory' },
      { uri: `${requestUri(REQUEST_A)}.pdf`, kind: 'file' },
    ]);
    fileSystem.entriesByDirectory.set(requestUri(REQUEST_A), []);
    fileSystem.entriesByDirectory.set(requestUri(REQUEST_B), []);
    fileSystem.deleteFailures.add(requestUri(REQUEST_B));

    await expect(registry.cleanupAbandoned()).resolves.toEqual<CleanupReceipt>({
      attempted: 2,
      deleted: 1,
      failed: 1,
      refused: 5,
    });
    expect(fileSystem.deleted).toEqual([requestUri(REQUEST_A)]);
  });

  it('returns a content-free failed recovery receipt when namespace enumeration fails', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add('file:///app/cache/resume-ai-v1');
    fileSystem.listFailure = true;

    await expect(registry.cleanupAbandoned()).resolves.toEqual<CleanupReceipt>({
      attempted: 0,
      deleted: 0,
      failed: 1,
      refused: 0,
    });
  });

  it.each([
    ['empty request', [], 0],
    ['one PDF', [{ uri: `${requestUri(REQUEST_A)}/${FILE_A}.pdf`, kind: 'file' as const }], 1],
    ['multiple PDFs', [
      { uri: `${requestUri(REQUEST_A)}/${FILE_A}.pdf`, kind: 'file' as const },
      { uri: `${requestUri(REQUEST_A)}/${FILE_B}.pdf`, kind: 'file' as const },
    ], 2],
  ])('reports actual deleted file count for %s', async (_name, files, deletedFiles) => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add(NAMESPACE_URI);
    fileSystem.directories.add(requestUri(REQUEST_A));
    fileSystem.entriesByDirectory.set(NAMESPACE_URI, [
      { uri: requestUri(REQUEST_A), kind: 'directory' },
    ]);
    fileSystem.entriesByDirectory.set(requestUri(REQUEST_A), files);

    await expect(cleanupDetailed(registry)).resolves.toEqual({
      attempted: 1,
      deleted: 1,
      failed: 0,
      refused: 0,
      deletedFiles,
      live: 0,
    });
  });

  it('refuses an unexpected child without deleting its request directory', async () => {
    const { fileSystem, registry } = harness();
    fileSystem.directories.add(NAMESPACE_URI);
    fileSystem.directories.add(requestUri(REQUEST_A));
    fileSystem.entriesByDirectory.set(NAMESPACE_URI, [
      { uri: requestUri(REQUEST_A), kind: 'directory' },
    ]);
    fileSystem.entriesByDirectory.set(requestUri(REQUEST_A), [
      { uri: `${requestUri(REQUEST_A)}/private.txt`, kind: 'file' },
    ]);

    await expect(cleanupDetailed(registry)).resolves.toEqual({
      attempted: 1,
      deleted: 0,
      failed: 0,
      refused: 1,
      deletedFiles: 0,
      live: 0,
    });
    expect(fileSystem.deleted).toEqual([]);
  });

  it('skips a live staged request across registry instances', async () => {
    const fileSystem = new RegistryFileSystem();
    const owner = new TempFileRegistry({ fileSystem });
    const cleaner = new TempFileRegistry({ fileSystem });
    await owner.stagePdf(REQUEST_A, FILE_A, 'file:///provider/resume.pdf');
    fileSystem.entriesByDirectory.set(NAMESPACE_URI, [
      { uri: requestUri(REQUEST_A), kind: 'directory' },
    ]);
    fileSystem.entriesByDirectory.set(requestUri(REQUEST_A), [
      { uri: `${requestUri(REQUEST_A)}/${FILE_A}.pdf`, kind: 'file' },
    ]);

    await expect(cleanupDetailed(cleaner)).resolves.toEqual({
      attempted: 0,
      deleted: 0,
      failed: 0,
      refused: 0,
      deletedFiles: 0,
      live: 1,
    });
    expect(fileSystem.deleted).toEqual([]);
    expect(fileSystem.directories.has(requestUri(REQUEST_A))).toBe(true);
  });

  it('recovers an inspection-failed stage after its immediate cleanup transiently fails', async () => {
    const fileSystem = new RegistryFileSystem();
    const owner = new TempFileRegistry({ fileSystem });
    const cleaner = new TempFileRegistry({ fileSystem });
    fileSystem.inspectFailure = true;
    fileSystem.deleteFailures.add(requestUri(REQUEST_A));

    await expect(owner.stagePdf(
      REQUEST_A,
      FILE_A,
      'file:///provider/resume.pdf',
    )).rejects.toBeInstanceOf(Error);
    await expect(owner.cleanupRequest(REQUEST_A)).resolves.toEqual({
      attempted: 1,
      deleted: 0,
      failed: 1,
      refused: 0,
    });
    fileSystem.deleteFailures.delete(requestUri(REQUEST_A));

    await expect(cleaner.cleanupAbandonedDetailed()).resolves.toEqual({
      attempted: 1,
      deleted: 1,
      failed: 0,
      refused: 0,
      deletedFiles: 1,
      live: 0,
    });
    expect(fileSystem.deleted).toEqual([requestUri(REQUEST_A)]);
  });

  it('does not accumulate live leases for repeated unique failed stages', async () => {
    const fileSystem = new RegistryFileSystem();
    const owner = new TempFileRegistry({ fileSystem });
    const cleaner = new TempFileRegistry({ fileSystem });
    fileSystem.inspectFailure = true;
    const failures = 32;

    for (let index = 1; index <= failures; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      const requestId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
      const fileId = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
      fileSystem.deleteFailures.add(requestUri(requestId));
      await expect(owner.stagePdf(
        requestId,
        fileId,
        'file:///provider/resume.pdf',
      )).rejects.toBeInstanceOf(Error);
      await expect(owner.cleanupRequest(requestId)).resolves.toMatchObject({ failed: 1 });
      fileSystem.deleteFailures.delete(requestUri(requestId));
    }

    await expect(cleaner.cleanupAbandonedDetailed()).resolves.toEqual({
      attempted: failures,
      deleted: failures,
      failed: 0,
      refused: 0,
      deletedFiles: failures,
      live: 0,
    });
  });

  it('serializes recovery of a failed stage before a new live stage', async () => {
    const listed = deferred<void>();
    const release = deferred<void>();
    class DeferredRecoveryFileSystem extends RegistryFileSystem {
      private firstNamespaceList = true;

      override async listDirectory(uri: string) {
        if (uri === NAMESPACE_URI && this.firstNamespaceList) {
          this.firstNamespaceList = false;
          listed.resolve();
          await release.promise;
        }
        return super.listDirectory(uri);
      }
    }
    const fileSystem = new DeferredRecoveryFileSystem();
    const owner = new TempFileRegistry({ fileSystem });
    const cleaner = new TempFileRegistry({ fileSystem });
    const stager = new TempFileRegistry({ fileSystem });
    fileSystem.inspectFailure = true;
    await expect(owner.stagePdf(
      REQUEST_A,
      FILE_A,
      'file:///provider/resume.pdf',
    )).rejects.toBeInstanceOf(Error);
    fileSystem.inspectFailure = false;

    const recovery = cleaner.cleanupAbandonedDetailed();
    await listed.promise;
    let staged = false;
    const staging = stager.stagePdf(REQUEST_B, FILE_B, 'file:///provider/resume.pdf')
      .then(value => { staged = true; return value; });
    await Promise.resolve();
    expect(staged).toBe(false);
    release.resolve();

    await expect(recovery).resolves.toMatchObject({ deleted: 1, deletedFiles: 1, live: 0 });
    await expect(staging).resolves.toMatchObject({ uri: `${requestUri(REQUEST_B)}/${FILE_B}.pdf` });
    expect(fileSystem.deleted).toEqual([requestUri(REQUEST_A)]);
    expect(fileSystem.directories.has(requestUri(REQUEST_B))).toBe(true);
  });

  it('keeps staging fenced after a caller times out until late abandoned cleanup quiesces', async () => {
    const listed = deferred<void>();
    const release = deferred<void>();
    class DeferredEnumerationFileSystem extends RegistryFileSystem {
      override async listDirectory(uri: string) {
        if (uri === NAMESPACE_URI) {
          listed.resolve();
          await release.promise;
          return [...this.directories]
            .filter(candidate => candidate !== NAMESPACE_URI)
            .map(uri => ({ uri, kind: 'directory' as const }));
        }
        return [];
      }
    }
    const fileSystem = new DeferredEnumerationFileSystem();
    fileSystem.directories.add(NAMESPACE_URI);
    fileSystem.directories.add(requestUri(REQUEST_A));
    const cleaner = new TempFileRegistry({ fileSystem });
    const stager = new TempFileRegistry({ fileSystem });
    const cleanup = cleaner.cleanupAbandoned();
    await listed.promise;

    await expect(Promise.race([
      cleanup.then(() => 'settled'),
      new Promise<string>(resolve => setTimeout(() => resolve('timed_out'), 5)),
    ])).resolves.toBe('timed_out');
    let stageSettled = false;
    const staging = stager.stagePdf(REQUEST_B, FILE_B, 'file:///provider/resume.pdf')
      .then(value => { stageSettled = true; return value; });
    await Promise.resolve();
    await Promise.resolve();
    expect(stageSettled).toBe(false);
    expect(fileSystem.directories.has(requestUri(REQUEST_B))).toBe(false);

    release.resolve();
    await cleanup;
    await staging;
    expect(fileSystem.deleted).toEqual([requestUri(REQUEST_A)]);
    expect(fileSystem.directories.has(requestUri(REQUEST_B))).toBe(true);
  });
});
