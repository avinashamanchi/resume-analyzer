import { MAX_PDF_BYTES, MAX_RESUME_CODE_POINTS } from '../src/domain/limits';
import {
  DocumentSourceError,
  DocumentSourceService,
  createPastedTextSource,
} from '../src/documents/documentSource';
import {
  FileInspection,
  TempFileRegistry,
  TempFileSystem,
} from '../src/documents/tempFileRegistry';
import { VisionAdapter } from '../src/documents/visionAdapter';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_FILE_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_URI = 'file:///provider/resume.pdf';
const NAMESPACE_URI = 'file:///app/cache/resume-ai-v1';

type ServiceOptions = NonNullable<ConstructorParameters<typeof DocumentSourceService>[0]>;
type PickerPort = NonNullable<ServiceOptions['picker']>;
type PickerResult = Awaited<ReturnType<PickerPort['pick']>>;

class SourceFileSystem implements TempFileSystem {
  readonly cacheDirectoryUri = 'file:///app/cache/';
  readonly directories = new Set<string>();
  readonly copied: Array<{ source: string; destination: string }> = [];
  readonly deleted: string[] = [];
  actualSize = 128;
  header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  copyFailure = false;
  inspectFailure = false;
  deleteFailure = false;

  async createDirectory(uri: string): Promise<void> {
    this.directories.add(uri);
  }

  async directoryExists(uri: string): Promise<boolean> {
    return this.directories.has(uri);
  }

  async listDirectory(uri: string) {
    if (uri === NAMESPACE_URI) {
      return [...this.directories]
        .filter(candidate => candidate.startsWith(`${NAMESPACE_URI}/`))
        .map(candidate => ({ uri: candidate, kind: 'directory' as const }));
    }
    return this.copied
      .filter(entry => entry.destination.startsWith(`${uri}/`))
      .map(entry => ({ uri: entry.destination, kind: 'file' as const }));
  }

  async copyFile(source: string, destination: string): Promise<void> {
    if (this.copyFailure) throw new Error('provider path and filename must not escape');
    this.copied.push({ source, destination });
  }

  async inspectFile(): Promise<FileInspection> {
    if (this.inspectFailure) throw new Error('private filename must not escape');
    return { exists: true, size: this.actualSize, header: this.header };
  }

  async deleteDirectory(uri: string): Promise<void> {
    if (this.deleteFailure) throw new Error('private cache path must not escape');
    this.deleted.push(uri);
    this.directories.delete(uri);
  }
}

function successResult(
  overrides: Partial<{
    name: unknown;
    mimeType: unknown;
    size: unknown;
    uri: unknown;
  }> = {},
): PickerResult {
  const value = <K extends keyof typeof overrides>(key: K, fallback: unknown): unknown =>
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;
  return {
    canceled: false,
    assets: [
      {
        name: value('name', 'resume.pdf'),
        mimeType: value('mimeType', 'application/pdf'),
        size: value('size', 128),
        uri: value('uri', PROVIDER_URI),
      },
    ],
  } as PickerResult;
}

function sourceHarness(result: PickerResult = successResult()) {
  const fileSystem = new SourceFileSystem();
  let releaseFailure = false;
  const picker = {
    pick: jest.fn(async () => result),
    release: jest.fn(async () => {
      if (releaseFailure) throw new Error('private provider cache details');
    }),
  };
  const registry = new TempFileRegistry({ fileSystem });
  const service = new DocumentSourceService({
    picker,
    registry,
    requestId: () => REQUEST_ID,
    fileId: () => FILE_ID,
  });
  return {
    fileSystem,
    picker,
    registry,
    service,
    failProviderRelease: () => {
      releaseFailure = true;
    },
  };
}

describe('DocumentSourceService', () => {
  it('returns a bounded filename only through the current-screen display wrapper', async () => {
    const { service } = sourceHarness(successResult({ name: 'Private Resume 2026.pdf' }));

    const picked = await service.pickPdfForDisplay();

    expect(picked?.displayName).toBe('Private Resume 2026.pdf');
    expect(picked?.source).not.toHaveProperty('name');
    expect(JSON.stringify(picked?.source)).not.toContain('Private Resume');
  });

  it('uses a generic bounded display label for an overlong picker filename', async () => {
    const { service } = sourceHarness(successResult({ name: `${'a'.repeat(81)}.pdf` }));

    await expect(service.pickPdfForDisplay()).resolves.toMatchObject({
      displayName: 'Selected resume.pdf',
    });
  });

  it('copies one valid PDF into a generated app-owned location without retaining its filename', async () => {
    const { fileSystem, picker, service } = sourceHarness();

    const source = await service.pickPdf();

    expect(source).toMatchObject({
      kind: 'pdf',
      requestId: REQUEST_ID,
      uri: `file:///app/cache/resume-ai-v1/${REQUEST_ID}/${FILE_ID}.pdf`,
      size: 128,
    });
    expect(typeof source?.lease).toBe('symbol');
    expect(source).not.toHaveProperty('name');
    expect(picker.pick).toHaveBeenCalledWith({
      type: 'application/pdf',
      copyToCacheDirectory: true,
      multiple: false,
    });
    expect(fileSystem.copied).toEqual([
      {
        source: PROVIDER_URI,
        destination: `file:///app/cache/resume-ai-v1/${REQUEST_ID}/${FILE_ID}.pdf`,
      },
    ]);
    expect(picker.release).toHaveBeenCalledWith(PROVIDER_URI);
  });

  it('returns null on an exact picker cancellation without creating cache content', async () => {
    const { fileSystem, picker, service } = sourceHarness({ canceled: true, assets: null });

    await expect(service.pickPdf()).resolves.toBeNull();
    expect(fileSystem.directories.size).toBe(0);
    expect(picker.release).not.toHaveBeenCalled();
  });

  it.each([
    ['missing MIME', { mimeType: null }],
    ['wrong MIME', { mimeType: 'text/plain' }],
    ['MIME parameters', { mimeType: 'application/pdf; charset=binary' }],
    ['wrong extension', { name: 'resume.txt' }],
    ['extension suffix trick', { name: 'resume.pdf.txt' }],
    ['empty file', { size: 0 }],
    ['negative size', { size: -1 }],
    ['fractional size', { size: 1.5 }],
    ['non-finite size', { size: Number.POSITIVE_INFINITY }],
    ['oversized file', { size: MAX_PDF_BYTES + 1 }],
    ['remote URI', { uri: 'https://example.test/resume.pdf' }],
    ['file URI authority', { uri: 'file://attacker.example/resume.pdf' }],
    ['encoded traversal', { uri: 'file:///provider/%2e%2e/resume.pdf' }],
  ])('rejects %s metadata before copying', async (_label, overrides) => {
    const { fileSystem, picker, service } = sourceHarness(successResult(overrides));

    await expect(service.pickPdf()).rejects.toMatchObject({ category: 'validation' });
    expect(fileSystem.copied).toHaveLength(0);
    expect(picker.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { canceled: false, assets: [] },
    { canceled: false, assets: [successResult().assets![0], successResult().assets![0]] },
    { canceled: false, assets: [null] },
    { canceled: false, assets: ['resume.pdf'] },
    { canceled: true, assets: [] },
    { canceled: 'false', assets: [successResult().assets![0]] },
  ] as unknown as PickerResult[])('rejects malformed and multiple picker results', async result => {
    const { service } = sourceHarness(result);
    await expect(service.pickPdf()).rejects.toMatchObject({ category: 'validation' });
  });

  it.each([
    ['invalid request identifier', () => 'not-a-request', () => FILE_ID],
    ['invalid file identifier', () => REQUEST_ID, () => 'not-a-file'],
    [
      'identifier generator failure',
      () => {
        throw new Error('private random source details');
      },
      () => FILE_ID,
    ],
  ])('maps %s to a stable privacy error', async (_label, requestId, fileId) => {
    const { registry } = sourceHarness();
    const service = new DocumentSourceService({
      picker: {
        pick: jest.fn(async () => successResult()),
        release: jest.fn(async () => undefined),
      },
      registry,
      requestId,
      fileId,
    });

    const error = await service.pickPdf().catch(value => value);

    expect(error).toBeInstanceOf(DocumentSourceError);
    expect(error).toMatchObject({ category: 'privacy' });
    expect(error.message).not.toContain('private random');
  });

  it.each([
    ['declared/actual size mismatch', (fs: SourceFileSystem) => (fs.actualSize = 127)],
    ['actual empty file', (fs: SourceFileSystem) => (fs.actualSize = 0)],
    ['actual oversized file', (fs: SourceFileSystem) => (fs.actualSize = MAX_PDF_BYTES + 1)],
    [
      'invalid PDF header',
      (fs: SourceFileSystem) => (fs.header = new Uint8Array([0x50, 0x44, 0x46, 0x2d, 0x20])),
    ],
    ['copy failure', (fs: SourceFileSystem) => (fs.copyFailure = true)],
    ['inspection failure', (fs: SourceFileSystem) => (fs.inspectFailure = true)],
  ])('awaits request cleanup after %s', async (_label, arrange) => {
    const { fileSystem, service } = sourceHarness();
    arrange(fileSystem);

    await expect(service.pickPdf()).rejects.toMatchObject({ category: 'validation' });
    expect(fileSystem.deleted).toEqual([
      `file:///app/cache/resume-ai-v1/${REQUEST_ID}`,
    ]);
  });

  it('reports a privacy failure instead of claiming cleanup after a staging failure', async () => {
    const { fileSystem, service } = sourceHarness();
    fileSystem.copyFailure = true;
    fileSystem.deleteFailure = true;

    const error = await service.pickPdf().catch(value => value);

    expect(error).toBeInstanceOf(DocumentSourceError);
    expect(error).toMatchObject({ category: 'privacy', code: 'cache_cleanup_failed' });
    expect(error.message).not.toContain('resume.pdf');
    expect(error.message).not.toContain('/provider');
  });

  it('allows later abandoned recovery after inspection and immediate cleanup both fail', async () => {
    const { fileSystem, service } = sourceHarness();
    const cleaner = new TempFileRegistry({ fileSystem });
    fileSystem.inspectFailure = true;
    fileSystem.deleteFailure = true;

    await expect(service.pickPdf()).rejects.toMatchObject({
      category: 'privacy',
      code: 'cache_cleanup_failed',
    });
    fileSystem.deleteFailure = false;

    await expect(cleaner.cleanupAbandonedDetailed()).resolves.toEqual({
      attempted: 1,
      deleted: 1,
      failed: 0,
      refused: 0,
      deletedFiles: 1,
      live: 0,
    });
    expect(fileSystem.deleted).toEqual([
      `file:///app/cache/resume-ai-v1/${REQUEST_ID}`,
    ]);
  });

  it('keeps a successfully returned PdfSource live during abandoned cleanup', async () => {
    const { fileSystem, service } = sourceHarness();
    const cleaner = new TempFileRegistry({ fileSystem });

    const source = await service.pickPdf();

    await expect(cleaner.cleanupAbandonedDetailed()).resolves.toEqual({
      attempted: 0,
      deleted: 0,
      failed: 0,
      refused: 0,
      deletedFiles: 0,
      live: 1,
    });
    expect(source).toMatchObject({ kind: 'pdf', requestId: REQUEST_ID });
    expect(typeof source?.lease).toBe('symbol');
    expect(JSON.stringify(source)).not.toContain('lease');
    expect(fileSystem.deleted).toEqual([]);
  });

  it.each([
    ['the second copy would succeed', false],
    ['the second copy would fail', true],
  ])('preserves the first PdfSource when a same-request picker collides and %s', async (_label, copyFailure) => {
    const fileSystem = new SourceFileSystem();
    const registry = new TempFileRegistry({ fileSystem });
    const firstPicker = {
      pick: jest.fn(async () => successResult()),
      release: jest.fn(async () => undefined),
    };
    const secondPicker = {
      pick: jest.fn(async () => successResult()),
      release: jest.fn(async () => undefined),
    };
    const firstService = new DocumentSourceService({
      picker: firstPicker,
      registry,
      requestId: () => REQUEST_ID,
      fileId: () => FILE_ID,
    });
    const secondService = new DocumentSourceService({
      picker: secondPicker,
      registry,
      requestId: () => REQUEST_ID,
      fileId: () => SECOND_FILE_ID,
    });
    const original = await firstService.pickPdf();
    if (original === null) throw new Error('expected a staged PDF');
    fileSystem.copyFailure = copyFailure;

    await expect(secondService.pickPdf()).rejects.toMatchObject({
      category: 'privacy',
      code: 'cache_request_in_use',
    });
    expect(fileSystem.copied).toEqual([
      {
        source: PROVIDER_URI,
        destination: `file:///app/cache/resume-ai-v1/${REQUEST_ID}/${FILE_ID}.pdf`,
      },
    ]);
    expect(fileSystem.directories.has(
      `file:///app/cache/resume-ai-v1/${REQUEST_ID}`,
    )).toBe(true);
    expect(original).toMatchObject({
      kind: 'pdf',
      requestId: REQUEST_ID,
      uri: `file:///app/cache/resume-ai-v1/${REQUEST_ID}/${FILE_ID}.pdf`,
    });

    await expect(registry.cleanupAbandonedDetailed()).resolves.toMatchObject({
      attempted: 0,
      deleted: 0,
      live: 1,
    });
    await expect(registry.cleanupRequest(REQUEST_ID, original.lease)).resolves.toEqual({
      attempted: 1,
      deleted: 1,
      failed: 0,
      refused: 0,
    });
    expect(fileSystem.directories.has(
      `file:///app/cache/resume-ai-v1/${REQUEST_ID}`,
    )).toBe(false);
  });

  it('does not delete the first PdfSource when a colliding picker release also fails', async () => {
    const fileSystem = new SourceFileSystem();
    const registry = new TempFileRegistry({ fileSystem });
    const firstService = new DocumentSourceService({
      picker: {
        pick: jest.fn(async () => successResult()),
        release: jest.fn(async () => undefined),
      },
      registry,
      requestId: () => REQUEST_ID,
      fileId: () => FILE_ID,
    });
    const collidingService = new DocumentSourceService({
      picker: {
        pick: jest.fn(async () => successResult()),
        release: jest.fn(async () => {
          throw new Error('private provider release details');
        }),
      },
      registry,
      requestId: () => REQUEST_ID,
      fileId: () => SECOND_FILE_ID,
    });
    const original = await firstService.pickPdf();
    if (original === null) throw new Error('expected a staged PDF');

    await expect(collidingService.pickPdf()).rejects.toMatchObject({
      category: 'privacy',
      code: 'provider_cleanup_failed',
    });
    expect(fileSystem.deleted).toEqual([]);
    expect(original).toMatchObject({
      requestId: REQUEST_ID,
      uri: `file:///app/cache/resume-ai-v1/${REQUEST_ID}/${FILE_ID}.pdf`,
    });
    await expect(registry.cleanupAbandonedDetailed()).resolves.toMatchObject({
      attempted: 0,
      deleted: 0,
      live: 1,
    });
    await expect(registry.cleanupRequest(REQUEST_ID, original.lease)).resolves.toMatchObject({ deleted: 1 });
  });

  it('fails closed and removes the owned copy when the picker cache copy cannot be released', async () => {
    const { failProviderRelease, fileSystem, service } = sourceHarness();
    failProviderRelease();

    await expect(service.pickPdf()).rejects.toMatchObject({
      category: 'privacy',
      code: 'provider_cleanup_failed',
    });
    expect(fileSystem.deleted).toEqual([
      `file:///app/cache/resume-ai-v1/${REQUEST_ID}`,
    ]);
  });

  it('uses the acquired lease for invalid-copy cleanup', async () => {
    const { fileSystem, registry, service } = sourceHarness();
    const cleanup = jest.spyOn(registry, 'cleanupRequest');
    fileSystem.actualSize = 127;

    await expect(service.pickPdf()).rejects.toMatchObject({ category: 'validation' });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]?.[0]).toBe(REQUEST_ID);
    expect(typeof cleanup.mock.calls[0]?.[1]).toBe('symbol');
  });

  it('a delayed provider-failure cleanup cannot delete a later same-request owner', async () => {
    const fileSystem = new SourceFileSystem();
    const registry = new TempFileRegistry({ fileSystem });
    const cleanup = jest.spyOn(registry, 'cleanupRequest');
    const service = new DocumentSourceService({
      picker: {
        pick: jest.fn(async () => successResult()),
        release: jest.fn(async () => {
          throw new Error('private provider cleanup detail');
        }),
      },
      registry,
      requestId: () => REQUEST_ID,
      fileId: () => FILE_ID,
    });
    await expect(service.pickPdf()).rejects.toMatchObject({
      category: 'privacy',
      code: 'provider_cleanup_failed',
    });
    const staleLease = cleanup.mock.calls[0]?.[1] as symbol;
    expect(typeof staleLease).toBe('symbol');
    const stagedB = await registry.stagePdf(
      REQUEST_ID,
      SECOND_FILE_ID,
      PROVIDER_URI,
    ) as Awaited<ReturnType<TempFileRegistry['stagePdf']>> & { readonly lease: symbol };

    await expect(registry.cleanupRequest(REQUEST_ID, staleLease)).resolves.toEqual({
      attempted: 0,
      deleted: 0,
      failed: 0,
      refused: 1,
    });
    await expect(registry.cleanupAbandonedDetailed()).resolves.toMatchObject({ live: 1 });
    await expect(registry.cleanupRequest(REQUEST_ID, stagedB.lease)).resolves.toMatchObject({
      deleted: 1,
    });
  });
});

describe('pasted resume text', () => {
  it('normalizes CRLF without trimming or changing other text', () => {
    expect(createPastedTextSource('  First\r\nSecond\rThird  ')).toEqual({
      kind: 'text',
      text: '  First\nSecond\rThird  ',
    });
  });

  it('accepts exactly 30,000 Unicode code points without truncation', () => {
    const text = '😀'.repeat(MAX_RESUME_CODE_POINTS);
    const source = createPastedTextSource(text);

    expect(Array.from(source.text)).toHaveLength(MAX_RESUME_CODE_POINTS);
    expect(source.text).toBe(text);
  });

  it.each([
    ['blank', ''],
    ['Unicode whitespace', ' \t\n\u00a0'],
    ['NUL', 'before\0after'],
    ['over-limit Unicode', '😀'.repeat(MAX_RESUME_CODE_POINTS + 1)],
  ])('rejects %s pasted text without returning a partial source', (_label, text) => {
    expect(() => createPastedTextSource(text)).toThrow(DocumentSourceError);
  });
});

describe('VisionAdapter capability boundary', () => {
  it('is Expo Go-safe and routes an absent native module to paste text', async () => {
    const adapter = new VisionAdapter({ lookup: () => null });

    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.extractReviewedText(PROVIDER_URI)).rejects.toMatchObject({
      category: 'unsupported_pdf',
      developmentBuildRequired: true,
      route: 'paste_text',
    });
  });

  it('returns native OCR only as an unreviewed draft', async () => {
    const adapter = new VisionAdapter({
      lookup: () => ({
        extractTextFromPdf: jest.fn(async () => ({ text: 'OCR draft', pageCount: 2 })),
      }),
    });

    expect(adapter.isAvailable()).toBe(true);
    await expect(adapter.extractReviewedText(PROVIDER_URI)).resolves.toEqual({
      kind: 'vision_text',
      text: 'OCR draft',
      reviewed: false,
      pageCount: 2,
    });
  });
});
