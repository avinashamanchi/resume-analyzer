import validFixture from '../../contracts/fixtures/analysis-valid.json';

import { MAX_JOB_DESCRIPTION_CODE_POINTS, MAX_RESUME_CODE_POINTS } from '../src/domain/limits';
import { ResumeApi } from '../src/api/resumeApi';
import { ResumeApiError } from '../src/domain/errors';

class TestFormData {
  readonly entries: Array<[string, unknown]> = [];

  append(name: string, value: unknown): void {
    this.entries.push([name, value]);
  }
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

const originalFormData = globalThis.FormData;

function response(status: number, data: unknown) {
  return {
    status,
    json: jest.fn().mockResolvedValue(data),
  } as unknown as Response;
}

function createApi(overrides: Partial<ConstructorParameters<typeof ResumeApi>[0]> = {}) {
  const installationTokens = {
    getOrIssue: jest.fn().mockResolvedValue('signed-token'),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  const fetchImpl: FetchMock = jest.fn().mockResolvedValue(response(200, validFixture));
  const activeFetch = (overrides.fetchImpl ?? fetchImpl) as FetchMock;
  const activeTokens = (overrides.installationTokens ?? installationTokens) as typeof installationTokens;
  const options = {
    apiBaseUrl: 'https://api.example.test',
    fetchImpl: activeFetch,
    installationTokens: activeTokens,
    requestId: () => validFixture.analysisId,
    timeoutMs: 1_000,
    ...overrides,
  };
  return {
    api: new ResumeApi(options),
    fetchImpl: activeFetch,
    installationTokens: activeTokens,
  };
}

describe('ResumeApi multipart boundary', () => {
  beforeEach(() => {
    (globalThis as unknown as { FormData: typeof TestFormData }).FormData = TestFormData;
    jest.useRealTimers();
  });

  afterAll(() => {
    (globalThis as unknown as { FormData: typeof originalFormData }).FormData = originalFormData;
  });

  it('builds exactly one bounded text source with consent and a canonical request UUID', async () => {
    const { api, fetchImpl } = createApi();

    await expect(
      api.analyze(
        {
          source: { kind: 'text', text: 'Resume content' },
          jobDescription: '  Backend engineer  ',
          consentVersion: '2026-08-04.v1',
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual(validFixture);

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toEqual({ Authorization: 'Installation signed-token' });
    expect(request.headers).not.toHaveProperty('Content-Type');
    expect((request.body as unknown as TestFormData).entries).toEqual([
      ['consent_version', '2026-08-04.v1'],
      ['request_id', validFixture.analysisId],
      ['job_description', 'Backend engineer'],
      ['resume_text', 'Resume content'],
      ['source_type', 'text'],
    ]);
  });

  it('uses only the PDF multipart source and rejects client-side source limits without truncation', async () => {
    const { api, fetchImpl } = createApi({
      fetchImpl: jest.fn().mockResolvedValue(response(200, {
        ...validFixture,
        sourceType: 'pdf',
        score: {
          ...validFixture.score,
          readinessScore: 70,
          label: 'Good',
          components: { structure: 25, impact: 25, readability: 20, keywords: null },
        },
      })),
    });
    await api.analyze(
      {
        source: {
          kind: 'pdf',
          uri: 'file:///private/resume.pdf',
          name: 'resume.pdf',
          mimeType: 'application/pdf',
          size: 1024,
        },
        consentVersion: '2026-08-04.v1',
      },
      new AbortController().signal,
    );
    expect((fetchImpl.mock.calls[0][1].body as unknown as TestFormData).entries).toEqual([
      ['consent_version', '2026-08-04.v1'],
      ['request_id', validFixture.analysisId],
      ['resume_pdf', { uri: 'file:///private/resume.pdf', name: 'resume.pdf', type: 'application/pdf' }],
    ]);

    await expect(
      api.analyze(
        {
          source: { kind: 'text', text: '💼'.repeat(MAX_RESUME_CODE_POINTS + 1) },
          consentVersion: '2026-08-04.v1',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces code-point limits and rejects blank job descriptions before network access', async () => {
    const { api, fetchImpl } = createApi();
    await expect(
      api.analyze(
        {
          source: { kind: 'text', text: 'Resume' },
          jobDescription: '💼'.repeat(MAX_JOB_DESCRIPTION_CODE_POINTS + 1),
          consentVersion: '2026-08-04.v1',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: 'validation' });
    await expect(
      api.analyze(
        {
          source: { kind: 'text', text: '  ' },
          consentVersion: '2026-08-04.v1',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects insecure or localhost API configuration instead of selecting a fallback origin', () => {
    expect(() => createApi({ apiBaseUrl: 'http://api.example.test' })).toThrow();
    expect(() => createApi({ apiBaseUrl: 'https://localhost:5000' })).toThrow();
  });

  it('parses JSON once and exposes only validated stable public errors', async () => {
    const payload = {
      schemaVersion: 1,
      code: 'rate_limited',
      message: 'Wait before trying again.',
      requestId: validFixture.analysisId,
      retryable: true,
    };
    const errorResponse = response(429, payload);
    const { api, fetchImpl } = createApi({ fetchImpl: jest.fn().mockResolvedValue(errorResponse) });

    await expect(
      api.analyze(
        { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      category: 'service',
      code: 'rate_limited',
      requestId: validFixture.analysisId,
      retryable: true,
    });
    expect(errorResponse.json).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new ResumeApiError('invalid_response').message).not.toContain('private@contact.example');
  });

  it('invalidates a rejected anonymous token without replaying sensitive input', async () => {
    const { api, fetchImpl, installationTokens } = createApi({
      fetchImpl: jest.fn().mockResolvedValue(response(401, {
        schemaVersion: 1,
        code: 'invalid_installation',
        message: 'Session expired.',
        requestId: validFixture.analysisId,
        retryable: false,
      })),
    });

    await expect(
      api.analyze(
        { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: 'service', code: 'invalid_installation' });
    expect(installationTokens.clear).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed for non-JSON, unknown, or excessive service responses without body leakage', async () => {
    const nonJson = { status: 200, json: jest.fn().mockRejectedValue(new Error('private response')) } as unknown as Response;
    const { api: nonJsonApi } = createApi({ fetchImpl: jest.fn().mockResolvedValue(nonJson) });
    await expect(
      nonJsonApi.analyze(
        { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: 'invalid_response' });

    const tooMany = JSON.parse(JSON.stringify(validFixture));
    tooMany.feedback.matchedKeywords = Array.from({ length: 21 }, (_, index) => `term-${index}`);
    const { api: invalidApi } = createApi({ fetchImpl: jest.fn().mockResolvedValue(response(200, { ...tooMany, unexpected: true })) });
    await expect(
      invalidApi.analyze(
        { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('links cancellation and timeout signals, then removes the timeout on every exit', async () => {
    jest.useFakeTimers();
    const fetchImpl: FetchMock = jest.fn((_url, _init) => new Promise<Response>(() => undefined));
    const { api } = createApi({ fetchImpl, timeoutMs: 10 });
    const caller = new AbortController();
    const pending = api.analyze(
      { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
      caller.signal,
    );
    await Promise.resolve();
    jest.advanceTimersByTime(10);
    await expect(pending).rejects.toMatchObject({ category: 'timeout' });
    expect((fetchImpl.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    const second = createApi({
      fetchImpl: jest.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => undefined)),
    });
    const cancelled = second.api.analyze(
      { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
      caller.signal,
    );
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({ category: 'cancelled' });
    expect(jest.getTimerCount()).toBe(0);
  });
});
