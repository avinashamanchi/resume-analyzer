import { z } from 'zod';

import {
  casefoldCharacterUnicode15,
  hasUnicode15Data,
  isPythonStripCharacter,
  normalizeNfkcUnicode15,
} from './generated/unicode15';
import { codePointLength } from './limits';

const ERROR_CODES = [
  'invalid_request',
  'invalid_installation',
  'rate_limited',
  'request_in_progress',
  'unsupported_file',
  'file_too_large',
  'pdf_too_many_pages',
  'pdf_encrypted',
  'pdf_invalid',
  'pdf_timeout',
  'scan_required',
  'resume_too_long',
  'scoring_input_limit',
  'ai_timeout',
  'ai_unavailable',
  'invalid_ai_response',
  'service_misconfigured',
  'service_unavailable',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function codePointText(minimum: number, maximum: number) {
  return z.string().superRefine((value, context) => {
    const length = codePointLength(value);
    if (length < minimum || length > maximum) {
      context.addIssue({
        code: 'custom',
        message: `Text must contain ${minimum} to ${maximum} Unicode code points.`,
      });
    }
  });
}

function labelFor(readinessScore: number): 'Needs work' | 'Developing' | 'Good' | 'Strong' {
  if (readinessScore < 50) return 'Needs work';
  if (readinessScore < 70) return 'Developing';
  if (readinessScore < 85) return 'Good';
  return 'Strong';
}

export function normalizeKeywordForService(value: string): string {
  if (!hasUnicode15Data()) throw new Error('Unicode service data is unavailable.');
  const normalized = normalizeNfkcUnicode15(value);
  if (normalized === null) throw new Error('Unicode service data is unavailable.');
  const characters = Array.from(normalized);
  let start = 0;
  let end = characters.length;
  while (start < end && isPythonStripCharacter(characters[start])) start += 1;
  while (end > start && isPythonStripCharacter(characters[end - 1])) end -= 1;
  let folded = '';
  for (const character of characters.slice(start, end)) {
    const mapped = casefoldCharacterUnicode15(character);
    if (mapped === null) throw new Error('Unicode service data is unavailable.');
    folded += mapped;
  }
  return folded;
}

export const ScoreComponentsSchema = z
  .object({
    structure: z.number().int().min(0).max(30),
    impact: z.number().int().min(0).max(40),
    readability: z.number().int().min(0).max(30),
    keywords: z.number().int().min(0).max(25).nullable(),
  })
  .strict()
  .superRefine((components, context) => {
    const maxima = components.keywords === null
      ? { structure: 30, impact: 40, readability: 30 }
      : { structure: 25, impact: 30, readability: 20 };
    for (const key of ['structure', 'impact', 'readability'] as const) {
      if (components[key] > maxima[key]) {
        context.addIssue({
          code: 'custom',
          message: `${key} exceeds its scoring-branch maximum`,
          path: [key],
        });
      }
    }
  });

export const ScoreSchema = z
  .object({
    scoreVersion: z.literal('resume-readiness-v1'),
    readinessScore: z.number().int().min(0).max(100),
    label: z.enum(['Needs work', 'Developing', 'Good', 'Strong']),
    components: ScoreComponentsSchema,
    explanations: z.array(codePointText(1, 240)).max(12),
  })
  .strict()
  .superRefine((score, context) => {
    const total =
      score.components.structure +
      score.components.impact +
      score.components.readability +
      (score.components.keywords ?? 0);
    if (total !== score.readinessScore) {
      context.addIssue({ code: 'custom', message: 'score component total mismatch' });
    }
    if (labelFor(score.readinessScore) !== score.label) {
      context.addIssue({ code: 'custom', message: 'score label mismatch' });
    }
  });

export const FeedbackSchema = z
  .object({
    matchedKeywords: z.array(codePointText(1, 600)).max(20),
    missingKeywords: z.array(codePointText(1, 600)).max(20),
    strengths: z.array(codePointText(1, 600)).min(1).max(12),
    improvements: z.array(codePointText(1, 600)).min(1).max(12),
    powerBullets: z.array(codePointText(1, 600)).max(10),
    summary: codePointText(1, 500),
    simulatedRecruiterComment: codePointText(1, 800).startsWith(
      'Simulated AI recruiter feedback:',
    ),
  })
  .strict()
  .superRefine((feedback, context) => {
    try {
      const matched = new Set(feedback.matchedKeywords.map(normalizeKeywordForService));
      if (feedback.missingKeywords.some((item) => matched.has(normalizeKeywordForService(item)))) {
        context.addIssue({ code: 'custom', message: 'keyword lists overlap' });
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'Unicode service data unavailable' });
    }
  });

export const AnalysisResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    analysisId: z.string().regex(UUID),
    sourceType: z.enum(['pdf', 'text', 'vision_text']),
    score: ScoreSchema,
    feedback: FeedbackSchema,
  })
  .strict();

export const AiAllowanceSchema = z
  .object({
    used: z.number().int().min(0).max(100),
    limit: z.union([z.literal(3), z.literal(100)]),
    resetsAt: z.string().datetime({ offset: false, precision: 0 }),
  })
  .strict()
  .refine(value => value.used <= value.limit, {
    message: 'used exceeds allowance limit',
    path: ['used'],
  });

const AiUnavailableSchema = z
  .object({
    status: z.enum([
      'not_requested',
      'quota_exhausted',
      'plan_verification_unavailable',
      'temporarily_unavailable',
      'timeout',
      'invalid_provider_response',
    ]),
    feedback: z.null(),
    allowance: AiAllowanceSchema.nullable(),
  })
  .strict();

export const AiResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('complete'),
      feedback: FeedbackSchema,
      allowance: AiAllowanceSchema,
    })
    .strict(),
  AiUnavailableSchema,
]);

export const AnalysisResponseV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    analysisId: z.string().regex(UUID),
    sourceType: z.enum(['reviewed_text', 'pdf']),
    score: ScoreSchema,
    ai: AiResultSchema,
  })
  .strict();

export const InstallationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    installationToken: codePointText(1, 2048),
  })
  .strict();

export const PublicErrorSchema = z
  .object({
    schemaVersion: z.literal(1),
    code: z.enum(ERROR_CODES),
    message: codePointText(1, 240),
    requestId: z.string().regex(UUID),
    retryable: z.boolean(),
  })
  .strict();

const AnalysisRequestContextSchema = z.object({ hasJobDescription: z.boolean() }).strict();

export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
export type AnalysisResponseV2 = z.infer<typeof AnalysisResponseV2Schema>;
export type InstallationResponse = z.infer<typeof InstallationResponseSchema>;
export type PublicError = z.infer<typeof PublicErrorSchema>;
export type AnalysisRequestContext = Readonly<z.infer<typeof AnalysisRequestContextSchema>>;

export function parseAnalysisResponse(
  value: unknown,
  context: AnalysisRequestContext,
): AnalysisResponse {
  const parsedContext = AnalysisRequestContextSchema.parse(context);
  const response = AnalysisResponseSchema.parse(value);
  const keywordsAreNull = response.score.components.keywords === null;
  if (keywordsAreNull === parsedContext.hasJobDescription) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'job-description keyword component mismatch',
        path: ['score', 'components', 'keywords'],
      },
    ]);
  }
  return response;
}
