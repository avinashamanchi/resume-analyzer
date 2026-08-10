import { z } from 'zod';

import { ScoreSchema } from '../domain/contracts';
import { codePointLength } from '../domain/limits';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedText(minimum: number, maximum: number) {
  return z.string().superRefine((value, context) => {
    const length = codePointLength(value);
    if (
      length < minimum ||
      length > maximum ||
      value.includes('\u0000') ||
      hasUnpairedSurrogate(value)
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid local workspace text.' });
    }
  });
}

function boundedLabel(maximum = 120) {
  return boundedText(1, maximum).superRefine((value, context) => {
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({ code: 'custom', message: 'Invalid local workspace label.' });
    }
  });
}

export const WorkspaceIdentifierSchema = z.string().regex(UUID_PATTERN);

export const WorkspaceTimestampSchema = z.string().superRefine((value, context) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    context.addIssue({ code: 'custom', message: 'Invalid workspace timestamp.' });
  }
});

export const WorkspacePlanSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.enum(['free', 'pro']),
    verifiedUntil: WorkspaceTimestampSchema,
    entitlementExpiresAt: WorkspaceTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'free' && value.entitlementExpiresAt !== null) {
      context.addIssue({ code: 'custom', message: 'Free plan cannot have a Pro expiration.' });
    }
    if (value.kind === 'pro' && value.entitlementExpiresAt === null) {
      context.addIssue({ code: 'custom', message: 'Pro plan requires an expiration.' });
    }
  });

export const VersionSnapshotSchema = z
  .object({
    id: WorkspaceIdentifierSchema,
    versionId: WorkspaceIdentifierSchema,
    createdAt: WorkspaceTimestampSchema,
    resumeText: boundedText(1, 30_000),
    score: ScoreSchema,
    keywords: z.array(boundedLabel(120)).max(100),
  })
  .strict();

export const ResumeVersionSchema = z
  .object({
    id: WorkspaceIdentifierSchema,
    title: boundedLabel(),
    roleLabel: boundedLabel().nullable(),
    createdAt: WorkspaceTimestampSchema,
    updatedAt: WorkspaceTimestampSchema,
    latestSnapshotId: WorkspaceIdentifierSchema,
  })
  .strict();

export const JobStatusSchema = z.enum([
  'saved',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'archived',
]);

export const JobRecordSchema = z
  .object({
    id: WorkspaceIdentifierSchema,
    companyLabel: boundedLabel(),
    roleLabel: boundedLabel(),
    status: JobStatusSchema,
    nextActionAt: WorkspaceTimestampSchema.nullable(),
    notes: boundedText(0, 2_000),
    linkedVersionId: WorkspaceIdentifierSchema.nullable(),
    createdAt: WorkspaceTimestampSchema,
    updatedAt: WorkspaceTimestampSchema,
  })
  .strict();

export const SaveVersionInputSchema = z
  .object({
    title: boundedLabel(),
    roleLabel: boundedLabel().nullable(),
    resumeText: boundedText(1, 30_000),
    score: ScoreSchema,
    keywords: z.array(boundedLabel(120)).max(100),
  })
  .strict();

export const AddSnapshotInputSchema = z
  .object({
    resumeText: boundedText(1, 30_000),
    score: ScoreSchema,
    keywords: z.array(boundedLabel(120)).max(100),
  })
  .strict();

export const SaveJobInputSchema = z
  .object({
    id: WorkspaceIdentifierSchema.optional(),
    companyLabel: boundedLabel(),
    roleLabel: boundedLabel(),
    status: JobStatusSchema,
    nextActionAt: WorkspaceTimestampSchema.nullable(),
    notes: boundedText(0, 2_000),
    linkedVersionId: WorkspaceIdentifierSchema.nullable(),
  })
  .strict();

export const WorkspaceCursorSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: WorkspaceTimestampSchema,
    id: WorkspaceIdentifierSchema,
  })
  .strict();

export const WorkspacePageRequestSchema = z
  .object({
    before: WorkspaceCursorSchema.nullable(),
    limit: z.number().int().min(1).max(50),
  })
  .strict();

export type WorkspacePlanSnapshot = Readonly<z.infer<typeof WorkspacePlanSnapshotSchema>>;
export type ResumeVersion = Readonly<z.infer<typeof ResumeVersionSchema>>;
export type VersionSnapshot = Readonly<z.infer<typeof VersionSnapshotSchema>>;
export type JobRecord = Readonly<z.infer<typeof JobRecordSchema>>;
export type SaveVersionInput = Readonly<z.infer<typeof SaveVersionInputSchema>>;
export type AddSnapshotInput = Readonly<z.infer<typeof AddSnapshotInputSchema>>;
export type SaveJobInput = Readonly<z.infer<typeof SaveJobInputSchema>>;
export type WorkspaceCursor = Readonly<z.infer<typeof WorkspaceCursorSchema>>;
export type WorkspacePageRequest = Readonly<z.infer<typeof WorkspacePageRequestSchema>>;
export type WorkspacePage<T> = Readonly<{
  items: readonly T[];
  nextCursor: WorkspaceCursor | null;
}>;

export type VersionComparison = Readonly<{
  scoreDelta: number;
  componentDeltas: Readonly<{
    structure: number;
    impact: number;
    readability: number;
    keywords: number | null;
  }>;
  addedKeywords: readonly string[];
  removedKeywords: readonly string[];
  addedLines: readonly string[];
  removedLines: readonly string[];
  truncated: boolean;
}>;
