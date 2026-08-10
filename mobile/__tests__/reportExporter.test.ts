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
    aiStatus: 'legacy_feedback_present',
    feedback: validFixture.feedback,
    ...overrides,
  } as ReportRecord;
}

function exporterHarness(options: Readonly<{
  shareAvailable?: boolean;
  shareAvailability?: Promise<boolean>;
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
    isAvailableAsync: jest.fn(() =>
      options.shareAvailability ?? Promise.resolve(options.shareAvailable ?? true)),
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

  it('exports generated feedback exactly and warns that it may restate private inputs', async () => {
    const syntheticEmail = 'candidate@example.invalid';
    const syntheticPrivateLine = '<Private project line from the resume>';
    const report = fixtureReport({
      feedback: {
        ...validFixture.feedback,
        summary: `Contact ${syntheticEmail}`,
        powerBullets: [syntheticPrivateLine],
      },
    });
    const { exporter, print } = exporterHarness();

    await exporter.export(report);

    const html = print.printToFileAsync.mock.calls[0][0].html;
    expect(html).toContain(`Contact ${syntheticEmail}`);
    expect(html).toContain('&lt;Private project line from the resume&gt;');
    expect(html).toContain(
      'Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content.',
    );
    expect(html).toContain(
      'Review generated feedback before saving, sharing, or allowing it to enter device backups.',
    );
    expect(html).not.toContain('never resume text');
    expect(html).not.toContain('rather than source material');
  });

  it('recovers abandoned generated reports before creating a new PDF', async () => {
    const { exporter, files, print } = exporterHarness();

    await exporter.export(fixtureReport());

    expect(files.cleanupAbandoned).toHaveBeenCalledTimes(1);
    expect(files.cleanupAbandoned).toHaveBeenCalledWith([]);
    expect(files.cleanupAbandoned.mock.invocationCallOrder[0])
      .toBeLessThan(print.printToFileAsync.mock.invocationCallOrder[0]);
  });

  it('describes the 30/40/30 score weights when no job description was scored', async () => {
    const { exporter, print } = exporterHarness();
    await exporter.export(fixtureReport({
      score: {
        ...validFixture.score,
        readinessScore: 85,
        components: { structure: 30, impact: 30, readability: 25, keywords: null },
      } as ReportRecord['score'],
    }));

    const html = print.printToFileAsync.mock.calls[0][0].html;
    expect(html).toContain(
      'assigns structure up to 30 points, impact up to 40 points, and readability up to 30 points',
    );
    expect(html).toContain('No job-description component is included in this score.');
    expect(html).not.toContain('assigns structure up to 25 points');
  });

  it('describes the 25/30/20/25 score weights when a job description was scored', async () => {
    const { exporter, print } = exporterHarness();
    await exporter.export(fixtureReport());

    const html = print.printToFileAsync.mock.calls[0][0].html;
    expect(html).toContain(
      'assigns structure up to 25 points, impact up to 30 points, readability up to 20 points, and keyword alignment up to 25 points',
    );
    expect(html).toContain('These components total at most 100 points.');
    expect(html).not.toContain('assigns structure up to 30 points');
  });

  it('renders only 30/40/30 component rows when no job description was scored', async () => {
    const { exporter, print } = exporterHarness();
    await exporter.export(fixtureReport({
      score: {
        ...validFixture.score,
        readinessScore: 85,
        components: { structure: 30, impact: 30, readability: 25, keywords: null },
      } as ReportRecord['score'],
    }));

    const html = print.printToFileAsync.mock.calls[0][0].html;
    expect(html).toContain('<th scope="row">Structure</th><td>30/30</td>');
    expect(html).toContain('<th scope="row">Impact</th><td>30/40</td>');
    expect(html).toContain('<th scope="row">Readability</th><td>25/30</td>');
    expect(html).not.toContain('<th scope="row">Keywords</th>');
    expect(html).not.toContain('<th scope="row">Impact</th><td>30/30</td>');
    expect(html).not.toContain('<th scope="row">Readability</th><td>25/20</td>');
  });

  it('renders 25/30/20/25 component rows when a job description was scored', async () => {
    const { exporter, print } = exporterHarness();
    await exporter.export(fixtureReport());

    const html = print.printToFileAsync.mock.calls[0][0].html;
    expect(html).toContain('<th scope="row">Structure</th><td>25/25</td>');
    expect(html).toContain('<th scope="row">Impact</th><td>25/30</td>');
    expect(html).toContain('<th scope="row">Readability</th><td>20/20</td>');
    expect(html).toContain('<th scope="row">Keywords</th><td>15/25</td>');
    expect(html).not.toContain('<th scope="row">Structure</th><td>25/30</td>');
    expect(html).not.toContain('<th scope="row">Impact</th><td>25/40</td>');
    expect(html).not.toContain('<th scope="row">Readability</th><td>20/30</td>');
  });

  it('opens sharing only from share and deletes after completion or cancellation', async () => {
    const { exporter, sharing, files } = exporterHarness();
    const receipt = await exporter.export(fixtureReport());
    expect(sharing.shareAsync).not.toHaveBeenCalled();

    await exporter.share(receipt, new AbortController().signal);

    expect(sharing.shareAsync).toHaveBeenCalledWith(PRINT_URI, {
      UTI: 'com.adobe.pdf',
      mimeType: 'application/pdf',
    });
    expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
    await expect(exporter.share(receipt, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_receipt' });
  });

  it.each(['route change', 'unmount', 'background']) (
    'cancels during deferred availability on %s without presenting or leaking the file path',
    async () => {
      let resolveAvailability!: (available: boolean) => void;
      const shareAvailability = new Promise<boolean>((resolve) => {
        resolveAvailability = resolve;
      });
      const { exporter, sharing, files } = exporterHarness({ shareAvailability });
      const receipt = await exporter.export(fixtureReport());
      const lifecycle = new AbortController();

      const sharingAttempt = exporter.share(receipt, lifecycle.signal);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sharing.isAvailableAsync).toHaveBeenCalledTimes(1);

      lifecycle.abort();
      resolveAvailability(true);
      const failure = await sharingAttempt.catch((error: unknown) => error);

      expect(failure).toEqual(new ReportExportError('share_cancelled'));
      expect(sharing.shareAsync).not.toHaveBeenCalled();
      expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
      expect(JSON.stringify(failure)).not.toContain(PRINT_URI);
      expect(String(failure)).not.toContain('/Print/');
      await expect(exporter.share(receipt, new AbortController().signal))
        .rejects.toMatchObject({ code: 'invalid_receipt' });
    },
  );

  it('discards an issued report with verified deletion without opening sharing', async () => {
    const { exporter, sharing, files } = exporterHarness();
    const receipt = await exporter.export(fixtureReport());

    await exporter.discard(receipt);

    expect(sharing.isAvailableAsync).not.toHaveBeenCalled();
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
    await expect(exporter.discard(receipt)).rejects.toMatchObject({ code: 'invalid_receipt' });
  });

  it('fails closed when discarded-report deletion cannot be verified', async () => {
    const { exporter, sharing } = exporterHarness({
      deleteFailure: new Error(`cannot delete ${PRINT_URI}`),
    });
    const receipt = await exporter.export(fixtureReport());

    await expect(exporter.discard(receipt)).rejects.toEqual(
      new ReportExportError('cleanup_failed'),
    );
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    await expect(exporter.discard(receipt)).rejects.toMatchObject({ code: 'invalid_receipt' });
  });

  it('deletes the generated report when sharing rejects without leaking its private cause', async () => {
    const privateFailure = new Error(`share failed for ${PRINT_URI}`);
    const { exporter, files } = exporterHarness({ shareFailure: privateFailure });
    const receipt = await exporter.export(fixtureReport());

    await expect(exporter.share(receipt, new AbortController().signal)).rejects.toEqual(
      new ReportExportError('share_failed'),
    );
    expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
    await expect(exporter.share(receipt, new AbortController().signal))
      .rejects.not.toThrow(PRINT_URI);
  });

  it('deletes without opening a share sheet when native sharing is unavailable', async () => {
    const { exporter, sharing, files } = exporterHarness({ shareAvailable: false });
    const receipt = await exporter.export(fixtureReport());

    await expect(exporter.share(receipt, new AbortController().signal))
      .rejects.toMatchObject({ code: 'sharing_unavailable' });
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(files.delete).toHaveBeenCalledWith(PRINT_URI);
  });

  it('fails closed with a path-free cleanup error when deletion cannot be verified', async () => {
    const { exporter } = exporterHarness({ deleteFailure: new Error(`cannot delete ${PRINT_URI}`) });
    const receipt = await exporter.export(fixtureReport());

    const failure = await exporter.share(receipt, new AbortController().signal)
      .catch((error: unknown) => error);

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

  it('rejects a report above the job-description branch maximum before rendering', async () => {
    const { exporter, print, sharing } = exporterHarness();
    const report = fixtureReport({
      score: {
        ...validFixture.score,
        readinessScore: 86,
        components: { ...validFixture.score.components, structure: 26 },
      } as ReportRecord['score'],
    });

    await expect(exporter.export(report)).rejects.toEqual(new ReportExportError('invalid_report'));
    expect(print.printToFileAsync).not.toHaveBeenCalled();
    expect(sharing.shareAsync).not.toHaveBeenCalled();
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
