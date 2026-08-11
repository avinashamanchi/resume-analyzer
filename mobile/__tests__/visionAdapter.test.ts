import { VisionAdapter } from '../src/documents/visionAdapter';
import type { PdfSource } from '../src/documents/documentSource';

const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FILE_ID = '11111111-1111-4111-8111-111111111111';
const PDF_URI = `file:///app/cache/resume-ai-v1/${REQUEST_ID}/${FILE_ID}.pdf`;
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';

function operation(): symbol {
  return Symbol('vision-operation');
}

function pdfSource(overrides: Partial<PdfSource> = {}): PdfSource {
  return Object.freeze({
    kind: 'pdf',
    requestId: REQUEST_ID,
    uri: PDF_URI,
    size: 1_024,
    lease: Symbol('pdf-lease'),
    ...overrides,
  });
}

describe('VisionAdapter development-build boundary', () => {
  it('reports a development-build requirement without invoking a missing native module', async () => {
    const lookup = jest.fn(() => null);
    const adapter = new VisionAdapter({ lookup });

    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.extractReviewedText(pdfSource(), operation())).rejects.toMatchObject({
      category: 'unsupported_pdf',
      code: 'vision_unavailable',
      developmentBuildRequired: true,
      route: 'paste_text',
      message: 'This PDF needs reviewed text before it can be analyzed.',
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('passes only the canonical staged URI and returns an immutable unreviewed draft', async () => {
    const extractTextFromPdf = jest.fn(async () => ({
      text: 'Experience\nBuilt accessible software',
      pageCount: 2,
    }));
    const cancelExtraction = jest.fn(async () => undefined);
    const adapter = new VisionAdapter({
      lookup: () => ({ extractTextFromPdf, cancelExtraction }),
      operationId: () => OPERATION_ID,
    });

    const draft = await adapter.extractReviewedText(pdfSource(), operation());

    expect(extractTextFromPdf).toHaveBeenCalledWith(PDF_URI, OPERATION_ID);
    expect(draft).toEqual({
      kind: 'vision_text',
      text: 'Experience\nBuilt accessible software',
      reviewed: false,
      pageCount: 2,
    });
    expect(Object.isFrozen(draft)).toBe(true);
  });

  it.each([
    ['non-file URI', { uri: 'https://example.com/private.pdf' }],
    ['wrong staged request identity', { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['missing lease', { lease: undefined as never }],
    ['empty file', { size: 0 }],
    ['oversized file', { size: 10 * 1024 * 1024 + 1 }],
  ] as const)('rejects %s before native OCR can read it', async (_label, overrides) => {
    const extractTextFromPdf = jest.fn(async () => ({ text: 'Private text', pageCount: 1 }));
    const adapter = new VisionAdapter({
      lookup: () => ({ extractTextFromPdf, cancelExtraction: jest.fn() }),
      operationId: () => OPERATION_ID,
    });

    await expect(adapter.extractReviewedText(pdfSource(overrides), operation())).rejects.toMatchObject({
      category: 'unsupported_pdf',
      code: 'vision_invalid_source',
      developmentBuildRequired: false,
    });
    expect(extractTextFromPdf).not.toHaveBeenCalled();
  });

  it.each([
    ['empty text', { text: '', pageCount: 1 }],
    ['NUL text', { text: 'private\0text', pageCount: 1 }],
    ['excessive text', { text: 'x'.repeat(30_001), pageCount: 1 }],
    ['zero pages', { text: 'text', pageCount: 0 }],
    ['too many pages', { text: 'text', pageCount: 11 }],
    ['extra native metadata', { text: 'text', pageCount: 1, uri: PDF_URI }],
  ] as const)('fails closed on %s without exposing native values', async (_label, result) => {
    const adapter = new VisionAdapter({
      lookup: () => ({
        extractTextFromPdf: jest.fn(async () => result),
        cancelExtraction: jest.fn(),
      }),
      operationId: () => OPERATION_ID,
    });

    let failure: unknown;
    try {
      await adapter.extractReviewedText(pdfSource(), operation());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      category: 'unsupported_pdf',
      code: 'vision_invalid_result',
      developmentBuildRequired: false,
      message: 'This PDF needs reviewed text before it can be analyzed.',
    });
    expect(String(failure)).not.toContain(PDF_URI);
    expect(String(failure)).not.toContain('private');
  });

  it('maps a private native rejection to one bounded path-free failure', async () => {
    const adapter = new VisionAdapter({
      lookup: () => ({
        extractTextFromPdf: jest.fn(async () => {
          throw new Error(`Vision failed at ${PDF_URI} while reading private text`);
        }),
        cancelExtraction: jest.fn(),
      }),
      operationId: () => OPERATION_ID,
    });

    await expect(adapter.extractReviewedText(pdfSource(), operation())).rejects.toMatchObject({
      category: 'unsupported_pdf',
      code: 'vision_native_failure',
      developmentBuildRequired: false,
      message: 'This PDF needs reviewed text before it can be analyzed.',
    });
  });

  it('uses one opaque native operation ID for extraction and cancellation until native settlement', async () => {
    let resolveNative!: (value: { text: string; pageCount: number }) => void;
    const nativeResult = new Promise<{ text: string; pageCount: number }>(resolve => {
      resolveNative = resolve;
    });
    const extractTextFromPdf = jest.fn(() => nativeResult);
    const cancelExtraction = jest.fn(async () => undefined);
    const authority = operation();
    const adapter = new VisionAdapter({
      lookup: () => ({ extractTextFromPdf, cancelExtraction }),
      operationId: () => OPERATION_ID,
    });

    const extraction = adapter.extractReviewedText(pdfSource(), authority);
    await Promise.resolve();
    await adapter.cancelExtraction(authority);

    expect(extractTextFromPdf).toHaveBeenCalledWith(PDF_URI, OPERATION_ID);
    expect(cancelExtraction).toHaveBeenCalledWith(OPERATION_ID);
    resolveNative({ text: 'Late bounded OCR text', pageCount: 1 });
    await expect(extraction).resolves.toMatchObject({ text: 'Late bounded OCR text' });

    await adapter.cancelExtraction(authority);
    expect(cancelExtraction).toHaveBeenCalledTimes(1);
  });

  it('treats a module without native cancellation as unavailable', () => {
    const adapter = new VisionAdapter({
      lookup: () => ({ extractTextFromPdf: jest.fn() } as never),
      operationId: () => OPERATION_ID,
    });

    expect(adapter.isAvailable()).toBe(false);
  });
});
