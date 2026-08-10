import { normalizeKeywordForService } from '../domain/contracts';
import {
  VersionSnapshotSchema,
  type VersionComparison,
  type VersionSnapshot,
} from './contracts';

const MAX_LINES = 2_000;
const MAX_CHANGED_LINES = 500;

export class ComparisonLimitError extends Error {
  readonly category = 'workspace_comparison' as const;

  constructor() {
    super('These versions are too large to compare safely on this device.');
    this.name = 'ComparisonLimitError';
  }
}

function lines(value: string): string[] {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const result = normalized.split('\n');
  if (result.length > MAX_LINES) throw new ComparisonLimitError();
  return result;
}

function matchingLine(value: string): string {
  return value.normalize('NFKC');
}

function changedLines(
  left: readonly string[],
  right: readonly string[],
): Readonly<{ added: string[]; removed: string[]; truncated: boolean }> {
  const availableLeft = new Map<string, number>();
  for (const line of left) {
    const key = matchingLine(line);
    availableLeft.set(key, (availableLeft.get(key) ?? 0) + 1);
  }

  const added: string[] = [];
  for (const line of right) {
    const key = matchingLine(line);
    const count = availableLeft.get(key) ?? 0;
    if (count > 0) {
      availableLeft.set(key, count - 1);
    } else if (added.length < MAX_CHANGED_LINES) {
      added.push(line);
    }
  }

  const availableRight = new Map<string, number>();
  for (const line of right) {
    const key = matchingLine(line);
    availableRight.set(key, (availableRight.get(key) ?? 0) + 1);
  }
  const removed: string[] = [];
  for (const line of left) {
    const key = matchingLine(line);
    const count = availableRight.get(key) ?? 0;
    if (count > 0) {
      availableRight.set(key, count - 1);
    } else if (removed.length < MAX_CHANGED_LINES) {
      removed.push(line);
    }
  }

  const unmatchedRight = [...availableLeft.values()].reduce((sum, count) => sum + count, 0);
  const unmatchedLeft = [...availableRight.values()].reduce((sum, count) => sum + count, 0);
  return {
    added,
    removed,
    truncated: unmatchedRight > MAX_CHANGED_LINES || unmatchedLeft > MAX_CHANGED_LINES,
  };
}

function keywordMap(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const key = normalizeKeywordForService(value);
    if (!result.has(key)) result.set(key, value);
  }
  return result;
}

function lexical(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function compareVersions(
  leftValue: VersionSnapshot,
  rightValue: VersionSnapshot,
): VersionComparison {
  const left = VersionSnapshotSchema.safeParse(leftValue);
  const right = VersionSnapshotSchema.safeParse(rightValue);
  if (!left.success || !right.success) throw new ComparisonLimitError();

  const leftLines = lines(left.data.resumeText);
  const rightLines = lines(right.data.resumeText);
  const lineChanges = changedLines(leftLines, rightLines);
  const leftKeywords = keywordMap(left.data.keywords);
  const rightKeywords = keywordMap(right.data.keywords);
  const addedKeywords = lexical(
    [...rightKeywords].filter(([key]) => !leftKeywords.has(key)).map(([, value]) => value),
  );
  const removedKeywords = lexical(
    [...leftKeywords].filter(([key]) => !rightKeywords.has(key)).map(([, value]) => value),
  );
  const leftKeywordScore = left.data.score.components.keywords;
  const rightKeywordScore = right.data.score.components.keywords;

  return Object.freeze({
    scoreDelta: right.data.score.readinessScore - left.data.score.readinessScore,
    componentDeltas: Object.freeze({
      structure: right.data.score.components.structure - left.data.score.components.structure,
      impact: right.data.score.components.impact - left.data.score.components.impact,
      readability: right.data.score.components.readability - left.data.score.components.readability,
      keywords: leftKeywordScore === null || rightKeywordScore === null
        ? null
        : rightKeywordScore - leftKeywordScore,
    }),
    addedKeywords: Object.freeze(addedKeywords),
    removedKeywords: Object.freeze(removedKeywords),
    addedLines: Object.freeze(lineChanges.added),
    removedLines: Object.freeze(lineChanges.removed),
    truncated: lineChanges.truncated,
  });
}
