import validFixture from '../../contracts/fixtures/analysis-valid.json';
import completeV2Fixture from '../../contracts/fixtures/analysis-v2-complete.json';
import deterministicOnlyV2Fixture from '../../contracts/fixtures/analysis-v2-deterministic-only.json';

import {
  AnalysisResponseSchema,
  AnalysisResponseV2Schema,
  PublicErrorSchema,
  type AnalysisResponseV2,
  normalizeKeywordForService,
  parseAnalysisResponse,
} from '../src/domain/contracts';

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function objectAt(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let current: unknown = root;
  for (const part of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error(`Expected object at ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error(`Expected object at ${path.join('.')}`);
  }
  return current as Record<string, unknown>;
}

function parseV2(value: unknown): AnalysisResponseV2 {
  if (AnalysisResponseV2Schema === undefined) {
    throw new Error('AnalysisResponseV2Schema is not implemented.');
  }
  return AnalysisResponseV2Schema.parse(value);
}

function expectV2ToReject(value: unknown): void {
  if (AnalysisResponseV2Schema === undefined) {
    throw new Error('AnalysisResponseV2Schema is not implemented.');
  }
  expect(() => AnalysisResponseV2Schema.parse(value)).toThrow();
}

describe('mobile service contracts', () => {
  it('accepts the canonical fixture with immutable request context', () => {
    const context = Object.freeze({ hasJobDescription: true });

    expect(parseAnalysisResponse(validFixture, context)).toEqual(validFixture);
    expect(context).toEqual({ hasJobDescription: true });
  });

  it('rejects unknown, non-canonical UUID, and internally inconsistent response fields', () => {
    expect(() => AnalysisResponseSchema.parse({ ...validFixture, unexpected: true })).toThrow();
    expect(() =>
      AnalysisResponseSchema.parse({
        ...validFixture,
        analysisId: validFixture.analysisId.toUpperCase(),
      }),
    ).toThrow();
    expect(() =>
      parseAnalysisResponse(
        {
          ...validFixture,
          score: {
            ...validFixture.score,
            readinessScore: 90,
            label: 'Needs work',
          },
        },
        Object.freeze({ hasJobDescription: true }),
      ),
    ).toThrow();
  });

  it('enforces score totals and request-context keyword null parity', () => {
    const noJob = copy(validFixture) as unknown as {
      score: {
        components: {
          structure: number;
          impact: number;
          readability: number;
          keywords: number | null;
        };
      };
    };
    noJob.score.components = {
      structure: 30,
      impact: 30,
      readability: 25,
      keywords: null,
    };

    expect(parseAnalysisResponse(noJob, Object.freeze({ hasJobDescription: false }))).toEqual(noJob);
    expect(() => parseAnalysisResponse(noJob, Object.freeze({ hasJobDescription: true }))).toThrow();
    expect(() => parseAnalysisResponse(validFixture, Object.freeze({ hasJobDescription: false }))).toThrow();
    expect(() =>
      parseAnalysisResponse(validFixture, Object.freeze({ hasJobDescription: true, extra: true })),
    ).toThrow();
  });

  it.each([
    ['job structure', { structure: 26, impact: 25, readability: 20, keywords: 15 }],
    ['job impact', { structure: 25, impact: 31, readability: 20, keywords: 15 }],
    ['job readability', { structure: 25, impact: 25, readability: 21, keywords: 15 }],
    ['no-job structure', { structure: 31, impact: 30, readability: 25, keywords: null }],
    ['no-job impact', { structure: 30, impact: 41, readability: 25, keywords: null }],
    ['no-job readability', { structure: 30, impact: 30, readability: 31, keywords: null }],
  ])('rejects a %s component above its branch maximum', (_name, components) => {
    const invalid = copy(validFixture) as unknown as Record<string, unknown>;
    const originalScore = invalid.score as Record<string, unknown>;
    const readinessScore = components.structure + components.impact + components.readability +
      (components.keywords ?? 0);
    invalid.score = {
      ...originalScore,
      readinessScore,
      label: readinessScore >= 85 ? 'Strong' : readinessScore >= 70 ? 'Good' : 'Developing',
      components,
    };

    expect(() => AnalysisResponseSchema.parse(invalid)).toThrow();
  });

  it('counts Unicode code points instead of UTF-16 code units for service text bounds', () => {
    const atLimit = copy(validFixture);
    atLimit.feedback.strengths = ['💼'.repeat(600)];
    expect(parseAnalysisResponse(atLimit, Object.freeze({ hasJobDescription: true }))).toEqual(atLimit);

    const overLimit = copy(atLimit);
    overLimit.feedback.strengths = ['💼'.repeat(601)];
    expect(() => parseAnalysisResponse(overLimit, Object.freeze({ hasJobDescription: true }))).toThrow();
  });

  it('requires the exact simulated-comment prefix and bounded list shapes', () => {
    const invalid = copy(validFixture);
    invalid.feedback.simulatedRecruiterComment = 'Recruiter feedback: private material';
    expect(() => parseAnalysisResponse(invalid, Object.freeze({ hasJobDescription: true }))).toThrow();

    const tooMany = copy(validFixture);
    tooMany.feedback.matchedKeywords = Array.from({ length: 21 }, (_, index) => `term-${index}`);
    expect(() => parseAnalysisResponse(tooMany, Object.freeze({ hasJobDescription: true }))).toThrow();
  });

  it('uses generated Python Unicode 15 NFKC, strip, and casefold parity for keyword overlap', () => {
    expect(normalizeKeywordForService('  Straße  ')).toBe('strasse');
    expect(normalizeKeywordForService('ﬃ')).toBe('ffi');
    expect(normalizeKeywordForService('\ua7f1')).not.toBe(normalizeKeywordForService('S'));

    const overlap = copy(validFixture);
    overlap.feedback.matchedKeywords = ['  ﬃ  '];
    overlap.feedback.missingKeywords = ['FFI'];
    expect(() => parseAnalysisResponse(overlap, Object.freeze({ hasJobDescription: true }))).toThrow();
  });

  it('strictly validates public errors without retaining unknown fields', () => {
    const error = {
      schemaVersion: 1,
      code: 'rate_limited',
      message: 'Wait before trying again.',
      requestId: validFixture.analysisId,
      retryable: true,
    };
    expect(PublicErrorSchema.parse(error)).toEqual(error);
    expect(() => PublicErrorSchema.parse({ ...error, body: 'resume text' })).toThrow();
  });

  it('accepts the content-free capacity response used before body upload', () => {
    const error = {
      schemaVersion: 1,
      code: 'capacity_limited',
      message: 'The service is busy. Please try again shortly.',
      requestId: validFixture.analysisId,
      retryable: true,
    };

    expect(PublicErrorSchema.parse(error)).toEqual(error);
  });

  it('accepts complete and deterministic-only v2 fixtures with the same score', () => {
    const complete = parseV2(completeV2Fixture);
    const deterministic = parseV2(deterministicOnlyV2Fixture);

    expect(complete.score.readinessScore).toBe(78);
    expect(complete.ai.status).toBe('complete');
    expect(complete.ai.feedback).not.toBeNull();
    if (complete.ai.status !== 'complete') throw new Error('Expected complete AI feedback.');
    expect(complete.ai.allowance.resetsAt).toBe('2026-09-01T00:00:00Z');
    expect(deterministic.score).toEqual(complete.score);
    expect(deterministic.ai.status).toBe('temporarily_unavailable');
    expect(deterministic.ai.feedback).toBeNull();
  });

  it.each([
    'not_requested',
    'quota_exhausted',
    'plan_verification_unavailable',
    'temporarily_unavailable',
    'timeout',
    'invalid_provider_response',
  ] as const)('accepts %s without feedback and with nullable allowance', status => {
    const withAllowance = copy(deterministicOnlyV2Fixture) as unknown as Record<string, unknown>;
    objectAt(withAllowance, ['ai']).status = status;
    const withoutAllowance = copy(withAllowance);
    objectAt(withoutAllowance, ['ai']).allowance = null;

    expect(parseV2(withAllowance).ai.status).toBe(status);
    expect(parseV2(withoutAllowance).ai.allowance).toBeNull();
  });

  it.each(['feedback', 'allowance'] as const)(
    'rejects a complete result with null %s',
    field => {
      const payload = copy(completeV2Fixture) as unknown as Record<string, unknown>;
      objectAt(payload, ['ai'])[field] = null;

      expectV2ToReject(payload);
    },
  );

  it.each([
    'not_requested',
    'quota_exhausted',
    'plan_verification_unavailable',
    'temporarily_unavailable',
    'timeout',
    'invalid_provider_response',
  ] as const)('rejects feedback when status is %s', status => {
    const payload = copy(completeV2Fixture) as unknown as Record<string, unknown>;
    objectAt(payload, ['ai']).status = status;

    expectV2ToReject(payload);
  });

  it('rejects unknown and missing v2 AI statuses', () => {
    const unknown = copy(deterministicOnlyV2Fixture) as unknown as Record<string, unknown>;
    objectAt(unknown, ['ai']).status = 'degraded';
    const missing = copy(deterministicOnlyV2Fixture) as unknown as Record<string, unknown>;
    delete objectAt(missing, ['ai']).status;

    expectV2ToReject(unknown);
    expectV2ToReject(missing);
  });

  it.each([
    '8EC8A3BC-7A15-4B75-9F94-A5353A2A2F9B',
    '8ec8a3bc7a154b759f94a5353a2a2f9b',
    '{8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b}',
    'urn:uuid:8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b',
  ])('rejects the noncanonical v2 UUID spelling %s', analysisId => {
    expectV2ToReject({
      ...completeV2Fixture,
      analysisId,
    });
  });

  it('accepts only reviewed_text and pdf as v2 source types', () => {
    expect(parseV2({
      ...completeV2Fixture,
      sourceType: 'pdf',
    }).sourceType).toBe('pdf');
    expectV2ToReject({
      ...completeV2Fixture,
      sourceType: 'vision_text',
    });
  });

  it.each([
    [-1, 3],
    [101, 100],
    [4, 3],
    [1.5, 3],
    [true, 3],
    [1, 4],
  ])('rejects invalid v2 allowance used=%p limit=%p', (used, limit) => {
    const payload = copy(completeV2Fixture) as unknown as Record<string, unknown>;
    const allowance = objectAt(payload, ['ai', 'allowance']);
    allowance.used = used;
    allowance.limit = limit;

    expectV2ToReject(payload);
  });

  it('accepts the exact pro allowance boundary', () => {
    const payload = copy(completeV2Fixture) as unknown as Record<string, unknown>;
    const allowance = objectAt(payload, ['ai', 'allowance']);
    allowance.used = 100;
    allowance.limit = 100;

    const parsed = parseV2(payload);

    expect(parsed.ai.allowance?.used).toBe(100);
  });

  it.each([
    '2026-09-01T00:00:00+00:00',
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00',
    '2026-09-01T00:00:00z',
    '2026-09-01',
    '2026-9-1T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-09-01T24:00:00Z',
  ])('rejects the noncanonical v2 reset timestamp %s', resetsAt => {
    const payload = copy(completeV2Fixture) as unknown as Record<string, unknown>;
    objectAt(payload, ['ai', 'allowance']).resetsAt = resetsAt;

    expectV2ToReject(payload);
  });

  it.each([
    { path: [] },
    { path: ['score'] },
    { path: ['score', 'components'] },
    { path: ['ai'] },
    { path: ['ai', 'feedback'] },
    { path: ['ai', 'allowance'] },
  ] as const)('rejects an unknown v2 field at $path', ({ path }) => {
    const payload = copy(completeV2Fixture) as unknown as Record<string, unknown>;
    objectAt(payload, path).unexpected = 'private input';

    expectV2ToReject(payload);
  });

  it.each([
    [[], 'schemaVersion'],
    [[], 'analysisId'],
    [[], 'sourceType'],
    [[], 'score'],
    [[], 'ai'],
    [['score'], 'components'],
    [['score', 'components'], 'keywords'],
    [['ai'], 'feedback'],
    [['ai'], 'allowance'],
    [['ai', 'feedback'], 'summary'],
    [['ai', 'allowance'], 'resetsAt'],
  ] as const)('rejects missing v2 field %s at %p', (path, field) => {
    const payload = copy(completeV2Fixture) as unknown as Record<string, unknown>;
    delete objectAt(payload, path)[field];

    expectV2ToReject(payload);
  });
});
