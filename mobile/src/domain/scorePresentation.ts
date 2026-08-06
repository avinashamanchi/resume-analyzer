import type { AnalysisResponse } from './contracts';

export type ScoreComponentPresentation = Readonly<{
  key: keyof AnalysisResponse['score']['components'];
  label: string;
  value: number;
  maximum: number;
}>;

export type ScorePresentation = Readonly<{
  hasJobDescription: boolean;
  components: readonly ScoreComponentPresentation[];
}>;

export function scorePresentation(
  components: AnalysisResponse['score']['components'],
): ScorePresentation {
  if (components.keywords === null) {
    return {
      hasJobDescription: false,
      components: [
        { key: 'structure', label: 'Structure', value: components.structure, maximum: 30 },
        { key: 'impact', label: 'Impact', value: components.impact, maximum: 40 },
        { key: 'readability', label: 'Readability', value: components.readability, maximum: 30 },
      ],
    };
  }
  return {
    hasJobDescription: true,
    components: [
      { key: 'structure', label: 'Structure', value: components.structure, maximum: 25 },
      { key: 'impact', label: 'Impact', value: components.impact, maximum: 30 },
      { key: 'readability', label: 'Readability', value: components.readability, maximum: 20 },
      { key: 'keywords', label: 'Keywords', value: components.keywords, maximum: 25 },
    ],
  };
}
