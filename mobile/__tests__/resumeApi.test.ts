import validFixture from '../../contracts/fixtures/analysis-valid.json';

import { MAX_JOB_DESCRIPTION_CODE_POINTS, MAX_RESUME_CODE_POINTS } from '../src/domain/limits';
import { validateApiBaseUrl } from '../src/api/apiBaseUrl';
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

function completeV2Response(
  fixture: Readonly<{ analysisId: string; score: unknown; feedback: unknown }> = validFixture,
  sourceType: 'reviewed_text' | 'pdf' = 'reviewed_text',
) {
  return {
    schemaVersion: 2,
    analysisId: fixture.analysisId,
    sourceType,
    score: fixture.score,
    ai: {
      status: 'complete',
      feedback: fixture.feedback,
      allowance: { used: 1, limit: 3, resetsAt: '2099-09-01T00:00:00Z' },
    },
  } as const;
}

function normalizedCompleteV2(
  fixture: Readonly<{ analysisId: string; score: unknown; feedback: unknown }> = validFixture,
  sourceType: 'reviewed_text' | 'pdf' = 'reviewed_text',
) {
  return {
    schemaVersion: 2,
    analysisId: fixture.analysisId,
    sourceType,
    score: fixture.score,
    aiStatus: 'complete',
    feedback: fixture.feedback,
    allowance: { used: 1, limit: 3, resetsAt: '2099-09-01T00:00:00Z' },
  } as const;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlePromptly<T>(promise: Promise<T>): Promise<
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<{ state: 'pending' }>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), 25);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ state: 'fulfilled' as const, value }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      ),
      pending,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function outcomeAfterMicrotasks<T>(promise: Promise<T>): Promise<
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' }
> {
  let outcome:
    | { state: 'fulfilled'; value: T }
    | { state: 'rejected'; error: unknown }
    | undefined;
  void promise.then(
    (value) => { outcome = { state: 'fulfilled', value }; },
    (error: unknown) => { outcome = { state: 'rejected', error }; },
  );
  for (let turn = 0; turn < 12 && outcome === undefined; turn += 1) {
    await Promise.resolve();
  }
  return outcome ?? { state: 'pending' };
}

function createApi(overrides: Partial<ConstructorParameters<typeof ResumeApi>[0]> = {}) {
  const installationTokens = {
    getOrIssue: jest.fn().mockResolvedValue('signed-token'),
    clear: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
  const fetchImpl: FetchMock = jest.fn().mockResolvedValue(response(200, completeV2Response()));
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

  it('submits reviewed text to v2 with exact admission headers and preserves deterministic score degradation', async () => {
    const v2Response = {
      schemaVersion: 2,
      analysisId: validFixture.analysisId,
      sourceType: 'reviewed_text',
      score: validFixture.score,
      ai: {
        status: 'temporarily_unavailable',
        feedback: null,
        allowance: { used: 1, limit: 3, resetsAt: '2099-09-01T00:00:00Z' },
      },
    };
    const { api, fetchImpl } = createApi({
      fetchImpl: jest.fn().mockResolvedValue(response(200, v2Response)),
    });

    await expect(api.analyze({
      source: { kind: 'reviewed_text', text: 'Reviewed resume text' },
      jobDescription: 'Backend engineer',
      consentVersion: '2026-08-04.v1',
      aiRequested: true,
    }, new AbortController().signal)).resolves.toEqual({
      schemaVersion: 2,
      analysisId: validFixture.analysisId,
      sourceType: 'reviewed_text',
      score: validFixture.score,
      aiStatus: 'temporarily_unavailable',
      feedback: null,
      allowance: { used: 1, limit: 3, resetsAt: '2099-09-01T00:00:00Z' },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v2/analyses',
      expect.objectContaining({
        headers: {
          Authorization: 'Installation signed-token',
          'X-Resume-AI': 'requested',
          'X-Resume-Request-ID': validFixture.analysisId,
          'X-Resume-Source': 'reviewed_text',
        },
      }),
    );
    const body = fetchImpl.mock.calls[0][1].body as unknown as TestFormData;
    expect(body.entries).toContainEqual(['resume_text', 'Reviewed resume text']);
    expect(body.entries.some(([name]) => name === 'resume_pdf')).toBe(false);
  });

  it('rejects malformed stored account identity before multipart allocation or network access', async () => {
    const { api, fetchImpl } = createApi({
      accountIdentity: {
        get: jest.fn(async () => ({
          accountToken: 'signed\r\nX-Injected: true',
          expiresAt: '2099-08-10T03:00:00Z',
          revenueCatAppUserId: `rai_account_${'a'.repeat(43)}`,
        } as never)),
      },
    });

    await expect(api.analyze({
      source: { kind: 'reviewed_text', text: 'Reviewed resume text' },
      consentVersion: '2026-08-04.v1',
    }, new AbortController().signal)).rejects.toMatchObject({
      category: 'invalid_response',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a malformed installation credential before multipart allocation or network access', async () => {
    const { api, fetchImpl } = createApi({
      installationTokens: {
        getOrIssue: jest.fn(async () => 'signed\r\nX-Injected: true'),
        clear: jest.fn(async () => undefined),
        invalidate: jest.fn(async () => undefined),
      },
    });

    await expect(api.analyze({
      source: { kind: 'reviewed_text', text: 'Reviewed resume text' },
      consentVersion: '2026-08-04.v1',
    }, new AbortController().signal)).rejects.toMatchObject({
      category: 'invalid_response',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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
    ).resolves.toEqual(normalizedCompleteV2());

    const [, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toEqual({
      Authorization: 'Installation signed-token',
      'X-Resume-AI': 'requested',
      'X-Resume-Request-ID': validFixture.analysisId,
      'X-Resume-Source': 'reviewed_text',
    });
    expect(request.headers).not.toHaveProperty('Content-Type');
    expect((request.body as unknown as TestFormData).entries).toEqual([
      ['consent_version', '2026-08-04.v1'],
      ['request_id', validFixture.analysisId],
      ['job_description', 'Backend engineer'],
      ['resume_text', 'Resume content'],
    ]);
  });

  it('uses only the PDF multipart source and rejects client-side source limits without truncation', async () => {
    const { api, fetchImpl } = createApi({
      fetchImpl: jest.fn().mockResolvedValue(response(200, completeV2Response({
        ...validFixture,
        score: {
          ...validFixture.score,
          readinessScore: 70,
          label: 'Good',
          components: { structure: 25, impact: 25, readability: 20, keywords: null },
        },
      }, 'pdf'))),
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

  it.each([
    'https://localhost.',
    'https://api.internal',
    'https://printer.local',
    'https://127.0.0.2',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://2130706433',
    'https://10.1.2.3',
    'https://172.16.0.1',
    'https://192.168.0.1',
    'https://169.254.1.1',
    'https://0.0.0.0',
    'https://192.0.0.8',
    'https://192.0.2.1',
    'https://198.51.100.1',
    'https://192.88.99.1',
    'https://224.0.0.1',
    'https://[::]',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:7f00:1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[100::1]',
    'https://[fec0::1]',
    'https://[2001:2::1]',
    'https://[2002:7f00:1::]',
  ])('rejects non-public API origin %s after URL canonicalization', (origin) => {
    expect(() => validateApiBaseUrl(origin)).toThrow();
  });

  it('canonicalizes a public hostname trailing dot without selecting a fallback', () => {
    expect(validateApiBaseUrl('https://api.example.test.')).toBe('https://api.example.test');
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
    expect(installationTokens.invalidate).toHaveBeenCalledWith('signed-token');
    expect(installationTokens.clear).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the validated 401 service error promptly when token invalidation hangs', async () => {
    jest.useFakeTimers();
    const neverClears = new Promise<void>(() => undefined);
    const { api, installationTokens } = createApi({
      fetchImpl: jest.fn().mockResolvedValue(response(401, {
        schemaVersion: 1,
        code: 'invalid_installation',
        message: 'Session expired.',
        requestId: validFixture.analysisId,
        retryable: false,
      })),
      installationTokens: {
        getOrIssue: jest.fn().mockResolvedValue('signed-token'),
        clear: jest.fn().mockResolvedValue(undefined),
        invalidate: jest.fn(() => neverClears),
      },
      timeoutMs: 10,
    });
    const controller = new AbortController();
    const pending = api.analyze(
      { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
      controller.signal,
    );

    await expect(pending).rejects.toMatchObject({
      category: 'service',
      code: 'invalid_installation',
    });
    expect(installationTokens.invalidate).toHaveBeenCalledWith('signed-token');
    expect(installationTokens.clear).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    controller.abort();
  });

  it('passes the exact old request token to a delayed 401 invalidation without disturbing newer token B', async () => {
    const delayed401 = deferred<Response>();
    let activeToken = 'token-A';
    const installationTokens = {
      getOrIssue: jest.fn(async (_signal: AbortSignal) => activeToken),
      clear: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn(async (expectedToken: string) => {
        if (expectedToken === activeToken) activeToken = '';
      }),
    };
    const fetchImpl: FetchMock = jest.fn()
      .mockResolvedValueOnce(response(200, completeV2Response()))
      .mockImplementationOnce(() => delayed401.promise);
    const { api } = createApi({ fetchImpl, installationTokens });

    const first = api.analyze(
      {
        source: { kind: 'text', text: 'First resume' },
        jobDescription: 'Engineer',
        consentVersion: '2026-08-04.v1',
      },
      new AbortController().signal,
    );
    const second = api.analyze(
      {
        source: { kind: 'text', text: 'Second resume' },
        jobDescription: 'Engineer',
        consentVersion: '2026-08-04.v1',
      },
      new AbortController().signal,
    );
    await expect(first).resolves.toEqual(normalizedCompleteV2());

    activeToken = 'token-B';
    delayed401.resolve(response(401, {
      schemaVersion: 1,
      code: 'invalid_installation',
      message: 'Session expired.',
      requestId: validFixture.analysisId,
      retryable: false,
    }));
    await expect(second).rejects.toMatchObject({ category: 'service', code: 'invalid_installation' });

    expect(installationTokens.invalidate).toHaveBeenCalledWith('token-A');
    expect(activeToken).toBe('token-B');
    await expect(installationTokens.getOrIssue(new AbortController().signal)).resolves.toBe('token-B');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    'resume',
    [],
    { source: null, consentVersion: '2026-08-04.v1' },
    { source: [], consentVersion: '2026-08-04.v1' },
    { source: 3, consentVersion: '2026-08-04.v1' },
    { source: { kind: 'text' }, consentVersion: '2026-08-04.v1' },
    { source: { kind: 'text', text: 'resume', unexpected: true }, consentVersion: '2026-08-04.v1' },
    { source: { kind: 'pdf', uri: null, name: 'resume.pdf', mimeType: 'application/pdf', size: 1 }, consentVersion: '2026-08-04.v1' },
    { source: {
      kind: 'pdf',
      uri: 'file:///private/resume.pdf',
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      size: 1,
      lease: Symbol(),
    }, consentVersion: '2026-08-04.v1' },
  ])('converts malformed runtime request input %#p into a stable validation error', async (input) => {
    const { api, fetchImpl } = createApi();

    await expect(api.analyze(input as never, new AbortController().signal)).rejects.toMatchObject({
      category: 'validation',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('rejects a service response whose job-scored structure exceeds its branch maximum', async () => {
    const malformed = JSON.parse(JSON.stringify(validFixture));
    malformed.score = {
      ...malformed.score,
      readinessScore: 86,
      components: { ...malformed.score.components, structure: 26 },
    };
    const { api } = createApi({
      fetchImpl: jest.fn().mockResolvedValue(response(200, malformed)),
    });

    await expect(api.analyze(
      {
        source: { kind: 'text', text: 'Resume' },
        jobDescription: 'Backend engineer',
        consentVersion: '2026-08-04.v1',
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('rejects declared or streamed oversized responses before parsing private content', async () => {
    const declaredJson = jest.fn(async () => completeV2Response());
    const declared = {
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '65537' : null },
      json: declaredJson,
    } as unknown as Response;
    const declaredApi = createApi({
      fetchImpl: jest.fn(async () => declared),
    }).api;
    await expect(declaredApi.analyze(
      { source: { kind: 'reviewed_text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
      new AbortController().signal,
    )).rejects.toMatchObject({ category: 'invalid_response' });
    expect(declaredJson).not.toHaveBeenCalled();

    const streamed = {
      status: 200,
      headers: { get: () => null },
      text: jest.fn(async () => 'x'.repeat(65_537)),
      json: jest.fn(),
    } as unknown as Response;
    const streamedApi = createApi({
      fetchImpl: jest.fn(async () => streamed),
    }).api;
    await expect(streamedApi.analyze(
      { source: { kind: 'reviewed_text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
      new AbortController().signal,
    )).rejects.toMatchObject({ category: 'invalid_response' });
    expect(streamed.json).not.toHaveBeenCalled();
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
    for (let turn = 0; turn < 12 && fetchImpl.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it('bounds a never-settling pre-commit token acquisition with the API timeout', async () => {
    jest.useFakeTimers();
    const neverIssues = new Promise<string>(() => undefined);
    const { api, fetchImpl } = createApi({
      installationTokens: {
        getOrIssue: jest.fn(() => neverIssues),
        clear: jest.fn().mockResolvedValue(undefined),
        invalidate: jest.fn().mockResolvedValue(undefined),
      },
      timeoutMs: 10,
    });

    try {
      const pending = api.analyze(
        { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
        new AbortController().signal,
      );
      jest.advanceTimersByTime(10);

      await expect(outcomeAfterMicrotasks(pending)).resolves.toMatchObject({
        state: 'rejected',
        error: { category: 'timeout' },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not construct multipart resume data while token acquisition is still pending', async () => {
    jest.useFakeTimers();
    let constructed = 0;
    class CountingFormData extends TestFormData {
      constructor() {
        super();
        constructed += 1;
      }
    }
    (globalThis as unknown as { FormData: typeof CountingFormData }).FormData = CountingFormData;
    const neverIssues = new Promise<string>(() => undefined);
    const { api, fetchImpl } = createApi({
      installationTokens: {
        getOrIssue: jest.fn(() => neverIssues),
        clear: jest.fn().mockResolvedValue(undefined),
        invalidate: jest.fn().mockResolvedValue(undefined),
      },
      timeoutMs: 10,
    });

    try {
      const pending = api.analyze(
        { source: { kind: 'text', text: 'private resume content' }, consentVersion: '2026-08-04.v1' },
        new AbortController().signal,
      );
      expect(constructed).toBe(0);
      jest.advanceTimersByTime(10);

      await expect(outcomeAfterMicrotasks(pending)).resolves.toMatchObject({
        state: 'rejected',
        error: { category: 'timeout' },
      });
      expect(constructed).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { FormData: typeof TestFormData }).FormData = TestFormData;
      jest.useRealTimers();
    }
  });

  it('returns an indeterminate token outcome and never starts analysis after a late commit', async () => {
    jest.useFakeTimers();
    const lateToken = deferred<string>();
    const commitStarted = deferred<void>();
    const { api, fetchImpl } = createApi({
      installationTokens: {
        getOrIssue: jest.fn((_signal: AbortSignal, lifecycle?: { onCommit(): void }) => {
          lifecycle?.onCommit();
          commitStarted.resolve();
          return lateToken.promise;
        }),
        clear: jest.fn().mockResolvedValue(undefined),
        invalidate: jest.fn().mockResolvedValue(undefined),
      },
      timeoutMs: 10,
    });

    try {
      const pending = api.analyze(
        { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
        new AbortController().signal,
      );
      await commitStarted.promise;
      jest.advanceTimersByTime(10);

      await expect(outcomeAfterMicrotasks(pending)).resolves.toMatchObject({
        state: 'rejected',
        error: { category: 'indeterminate', retryable: true },
      });
      lateToken.resolve('late-token');
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
