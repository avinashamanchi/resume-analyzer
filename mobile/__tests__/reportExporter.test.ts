import validFixture from '../../contracts/fixtures/analysis-valid.json';

import {
  ReportExporter,
  ReportExportError,
  ReportFileStore,
  type ReportFileSystem,
} from '../src/export/reportExporter';
import type { ReportRecord } from '../src/storage/reportRepository';

const PRINT_URI = 'file:///app/cache/Print/11111111-1111-4111-8111-111111111111.pdf';

function fixtureReport(overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id: validFixture.analysisId,
    title: 'Resume analysis',
    createdAt: '2026-08-05T19:20:30.000Z',
    sourceType: validFixture.sourceType,
    score: validFixture.score,
    feedback: validFixture.feedback,
    ...overrides,
  } as ReportRecord;
}

function exporterHarness(options: Readonly<{
  shareAvailable?: boolean;
  shareFailure?: Error;
  deleteFailure?: Error;
}> = {}) {
  const print = {
    printToFileAsync: jest.fn(async (_options: Readonly<{
      html: string;
      base64: false;
      margins: Readonly<{ top: number; right: number; bottom: number; left: number }>;
    }>) => ({ uri: PRINT_URI, numberOfPages: 2 })),
  };
  const sharing = {
    isAvailableAsync: jest.fn(async () => options.shareAvailable ?? true),
    shareAsync: options.shareFailure === undefined
      ? jest.fn(async () => undefined)
      : jest.fn(async () => { throw options.shareFailure; }),
  };
  const files = {
    owns: jest.fn((uri: string) => uri === PRINT_URI),
    cleanupAbandoned: jest.fn(async () => 0),
    delete: options.deleteFailure === undefined
      ? jest.fn(async () => undefined)
      : jest.fn(async () => { throw options.deleteFailure; }),
  };
  return {
    exporter: new ReportExporter({ print, sharing, files }),
    print,
    sharing,
    files,
  };
}

describe('native report exporter', () => {
  it('escapes every report-controlled text value before Print receives HTML', async () => {
    const dangerous = `amp& less< greater> quote" apostrophe'`;
    const report = fixtureReport({
      title: `Title ${dangerous}`,
      score: {
        ...validFixture.score,
        explanations: [`Explanation ${dangerous}`],
      } as ReportRecord['score'],
      feedback: {
        matchedKeywords: [`Matched ${dangerous}`],
        missingKeywords: [`Missing ${dangerous}`],
        strengths: [`Strength ${dangerous}`],
        improvements: [`Improvement ${dangerous}`],
        powerBullets: [`Bullet ${dangerous}`],
        summary: `<img src=x onerror="alert('summary')"> & summary`,
        simulatedRecruiterComment: `Simulated AI recruiter feedback: ${dangerous}`,
      },
    });
    const { exporter, print, sharing } = exporterHarness();

    const receipt = await exporter.export(report);
    const html = print.printToFileAsync.mock.calls[0][0].html;

    expect(html).toContain('amp&amp; less&lt; greater&gt; quote&quot; apostrophe&#39;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(&#39;summary&#39;)&quot;&gt; &amp; summary');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain(dangerous);
    expect(html).toContain('resume-readiness-v1');
    expect(html).toContain('AI-generated guidance may be incorrect');
    expect(html).toContain('system-ui, -apple-system, BlinkMacSystemFont');
    expect(print.printToFileAsync).toHaveBeenCalledWith(expect.objectContaining({
      base64: false,
      html: expect.stringContaining('<!doctype html>'),
    }));
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).toBe('{"numberOfPages":2}');
    expect(JSON.stringify(receipt)).not.toMatch(/file:|\/Print\//i);
  });

  it('recovers abandoned generated reports before creating a new PDF', async () => {
    const { exporter, files, print } = exporterHarness();

    await exporter.export(fixtureReport());

    expect(files.cleanupAbandoned).toHaveBeenCalledTimes(1);
    expect(files.cleanupAbandoned).toHaveBeenCalledWith([]);
    expect(files.cleanupAbandoned.mock.invocationCallOrder[0])
      .toBeLessThan(print.printToFileAsync.mock.invocationCallOrder[0]);
  });

  it('opens sharing only from share and deletes after completion or cancellation', async () => {
    const { exporter, sharing, files } = exporterHarness();
    const receipt = await exporter.export(fixtureReport());
    expect(sharing.shareAsync).not.toHaveBeenCalled();

    await exporter.share(receipt);

    expect(sharing.shareAsync).toHaveBeenCalledWith(PRINT_URI, {
      UTI: 'com.adobe.pdf',
      mimeType: 'application/pdf',
    });
    expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
    await expect(exporter.share(receipt)).rejects.toMatchObject({ code: 'invalid_receipt' });
  });

  it('deletes the generated report when sharing rejects without leaking its private cause', async () => {
    const privateFailure = new Error(`share failed for ${PRINT_URI}`);
    const { exporter, files } = exporterHarness({ shareFailure: privateFailure });
    const receipt = await exporter.export(fixtureReport());

    await expect(exporter.share(receipt)).rejects.toEqual(
      new ReportExportError('share_failed'),
    );
    expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
    await expect(exporter.share(receipt)).rejects.not.toThrow(PRINT_URI);
  });

  it('deletes without opening a share sheet when native sharing is unavailable', async () => {
    const { exporter, sharing, files } = exporterHarness({ shareAvailable: false });
    const receipt = await exporter.export(fixtureReport());

    await expect(exporter.share(receipt)).rejects.toMatchObject({ code: 'sharing_unavailable' });
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
  });

  it('fails closed with a path-free cleanup error when deletion cannot be verified', async () => {
    const { exporter } = exporterHarness({ deleteFailure: new Error(`cannot delete ${PRINT_URI}`) });
    const receipt = await exporter.export(fixtureReport());

    const failure = await exporter.share(receipt).catch((error: unknown) => error);

    expect(failure).toEqual(new ReportExportError('cleanup_failed'));
    expect(JSON.stringify(failure)).not.toContain(PRINT_URI);
    expect(String(failure)).not.toContain('/Print/');
  });

  it('rejects a Print result outside the owned Print directory without deleting it', async () => {
    const { exporter, print, files } = exporterHarness();
    print.printToFileAsync.mockResolvedValueOnce({
      uri: 'file:///private/raw-resume.pdf',
      numberOfPages: 1,
    });

    await expect(exporter.export(fixtureReport())).rejects.toMatchObject({ code: 'invalid_output' });
    expect(files.delete).not.toHaveBeenCalled();
  });
});

class FakeReportFileSystem implements ReportFileSystem {
  readonly cacheDirectoryUri = 'file:///app/cache/';
  readonly entries = new Map<string, 'file' | 'directory'>([
    [PRINT_URI, 'file'],
    ['file:///app/cache/Print/not-owned.pdf', 'file'],
    ['file:///app/cache/Print/22222222-2222-4222-8222-222222222222.txt', 'file'],
    ['file:///app/cache/Print/nested', 'directory'],
  ]);
  readonly deleted: string[] = [];

  async directoryExists(): Promise<boolean> { return true; }
  async listDirectory() {
    return [...this.entries].map(([uri, kind]) => ({ uri, kind }));
  }
  async fileExists(uri: string): Promise<boolean> { return this.entries.has(uri); }
  async deleteFile(uri: string): Promise<void> {
    this.deleted.push(uri);
    this.entries.delete(uri);
  }
}

describe('Expo Print cache ownership boundary', () => {
  it('recovery deletes only UUID PDFs directly generated in Print and protects active exports', async () => {
    const fileSystem = new FakeReportFileSystem();
    const files = new ReportFileStore({ fileSystem });

    expect(files.owns(PRINT_URI)).toBe(true);
    expect(files.owns('file:///app/cache/Print/not-owned.pdf')).toBe(false);
    expect(files.owns('file:///app/cache/Print/nested/11111111-1111-4111-8111-111111111111.pdf')).toBe(false);
    expect(files.owns('file:///private/11111111-1111-4111-8111-111111111111.pdf')).toBe(false);

    await files.cleanupAbandoned([PRINT_URI]);
    expect(fileSystem.deleted).toEqual([]);

    await files.cleanupAbandoned([]);
    expect(fileSystem.deleted).toEqual([PRINT_URI]);
    expect(fileSystem.entries.has('file:///app/cache/Print/not-owned.pdf')).toBe(true);
    expect(fileSystem.entries.has('file:///app/cache/Print/22222222-2222-4222-8222-222222222222.txt')).toBe(true);
  });
});
