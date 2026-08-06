import validFixture from '../../contracts/fixtures/analysis-valid.json';

import {
  AnalysisResponseSchema,
  PublicErrorSchema,
  normalizeKeywordForService,
  parseAnalysisResponse,
} from '../src/domain/contracts';

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
});
