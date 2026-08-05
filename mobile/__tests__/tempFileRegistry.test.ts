import {
  CleanupReceipt,
  FileInspection,
  TempFileRegistry,
  TempFileSystem,
} from '../src/documents/tempFileRegistry';

const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class RegistryFileSystem implements TempFileSystem {
  readonly cacheDirectoryUri = 'file:///app/cache/';
  readonly directories = new Set<string>();
  entries: Array<{ uri: string; kind: 'file' | 'directory' }> = [];
  deleteFailures = new Set<string>();
  deleted: string[] = [];
  listFailure = false;
  deleteNoop = false;

  async createDirectory(uri: string): Promise<void> {
    this.directories.add(uri);
  }

  async directoryExists(uri: string): Promise<boolean> {
    return this.directories.has(uri);
  }

  async listDirectory(): Promise<readonly { uri: string; kind: 'file' | 'directory' }[]> {
    if (this.listFailure) throw new Error('private listing details');
    return this.entries;
  }

  async copyFile(): Promise<void> {}

  async inspectFile(): Promise<FileInspection> {
    return {
      exists: true,
      size: 1,
      header: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    };
  }

  async deleteDirectory(uri: string): Promise<void> {
    if (this.deleteFailures.has(uri)) throw new Error('private delete details');
    this.deleted.push(uri);
    if (!this.deleteNoop) this.directories.delete(uri);
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
    fileSystem.entries = [
      { uri: requestUri(REQUEST_A), kind: 'directory' },
      { uri: requestUri(REQUEST_B), kind: 'directory' },
      { uri: 'file:///app/cache/resume-ai-v1/not-a-uuid', kind: 'directory' },
      { uri: 'file:///app/cache/resume-ai-v1/%2e%2e/outside', kind: 'directory' },
      { uri: 'file:///app/cache/resume-ai-v1-evil/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'directory' },
      { uri: `${requestUri(REQUEST_A)}/nested`, kind: 'directory' },
      { uri: `${requestUri(REQUEST_A)}.pdf`, kind: 'file' },
    ];
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
});
