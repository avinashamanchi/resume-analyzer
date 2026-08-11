import validFixture from '../../contracts/fixtures/analysis-valid.json';

import {
  ComparisonLimitError,
  compareVersions,
} from '../src/workspace/compareVersions';
import type { VersionSnapshot } from '../src/workspace/contracts';

const LEFT: VersionSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-08-09T10:00:00.000Z',
  resumeText: 'Built backend services.\nLed a small team.',
  score: {
    ...validFixture.score,
    scoreVersion: 'resume-readiness-v1',
    readinessScore: 78,
    label: 'Good',
    components: { structure: 23, impact: 23, readability: 17, keywords: 15 },
  },
  keywords: ['Python'],
};

const RIGHT: VersionSnapshot = {
  ...LEFT,
  id: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-08-09T11:00:00.000Z',
  resumeText: 'Built an audited Redis limiter.\r\nLed a small team.',
  score: {
    ...validFixture.score,
    scoreVersion: 'resume-readiness-v1',
    label: 'Strong',
  },
  keywords: ['Python', 'Redis'],
};

describe('bounded local version comparison', () => {
  it('compares score components, keywords, and changed lines without a network dependency', () => {
    expect(compareVersions(LEFT, RIGHT)).toEqual({
      scoreDelta: 7,
      componentDeltas: { structure: 2, impact: 2, readability: 3, keywords: 0 },
      addedKeywords: ['Redis'],
      removedKeywords: [],
      addedLines: ['Built an audited Redis limiter.'],
      removedLines: ['Built backend services.'],
      truncated: false,
    });
  });

  it('preserves displayed text while normalizing only for matching', () => {
    const left = { ...LEFT, resumeText: 'Cafe\u0301 project' };
    const right = { ...RIGHT, resumeText: 'Café project' };

    expect(compareVersions(left, right)).toMatchObject({
      addedLines: [],
      removedLines: [],
    });
    expect(left.resumeText).toBe('Cafe\u0301 project');
    expect(right.resumeText).toBe('Café project');
  });

  it('caps displayed output while processing at most 2,000 lines', () => {
    const left = { ...LEFT, resumeText: Array.from({ length: 2_000 }, (_, index) => `old-${index}`).join('\n') };
    const right = { ...RIGHT, resumeText: Array.from({ length: 2_000 }, (_, index) => `new-${index}`).join('\n') };

    const result = compareVersions(left, right);

    expect(result.addedLines).toHaveLength(500);
    expect(result.removedLines).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('rejects a 2,001-line input before diffing', () => {
    const oversized = { ...LEFT, resumeText: Array.from({ length: 2_001 }, () => 'line').join('\n') };

    expect(() => compareVersions(oversized, RIGHT)).toThrow(ComparisonLimitError);
  });
});
