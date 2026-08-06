import { render } from '@testing-library/react-native';
import React from 'react';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import { ScoreCard } from '../src/components/ScoreCard';
import type { AnalysisResponse } from '../src/domain/contracts';

describe('score component presentation', () => {
  it('shows only the 30/40/30 branch when no job description was scored', async () => {
    const score = {
      ...validFixture.score,
      readinessScore: 85,
      components: { structure: 30, impact: 30, readability: 25, keywords: null },
    } as AnalysisResponse['score'];

    const view = await render(<ScoreCard score={score} />);

    expect(view.getByText('30/30')).toBeTruthy();
    expect(view.getByText('30/40')).toBeTruthy();
    expect(view.getByText('25/30')).toBeTruthy();
    expect(view.queryByText('Keywords')).toBeNull();
    expect(view.queryByText('Not scored')).toBeNull();
  });

  it('shows the 25/30/20/25 branch when a job description was scored', async () => {
    const view = await render(
      <ScoreCard score={validFixture.score as AnalysisResponse['score']} />,
    );

    expect(view.getByText('25/25')).toBeTruthy();
    expect(view.getByText('25/30')).toBeTruthy();
    expect(view.getByText('20/20')).toBeTruthy();
    expect(view.getByText('15/25')).toBeTruthy();
    expect(view.getByText('Keywords')).toBeTruthy();
  });
});
