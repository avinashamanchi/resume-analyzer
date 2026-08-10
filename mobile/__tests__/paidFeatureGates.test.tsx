import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';
import { ResultsScreen } from '../app/results/[analysisId]';
import { AppControllerProvider } from '../src/controllers/AppController';
import type { ReportExporterPort } from '../src/export/reportExporter';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ analysisId: '8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b' }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

it('keeps the fourth saved report and PDF export behind Resume.AI Pro', async () => {
  const reports = Array.from({ length: 3 }, (_, index) => ({
    ...validFixture,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title: `Saved report ${index + 1}`,
    createdAt: `2026-08-0${index + 1}T12:00:00.000Z`,
  }));
  const values = {
    actions: {
      pickPdfForDisplay: jest.fn(), resetConsent: jest.fn(), cleanupCache: jest.fn(),
      shareSummary: jest.fn(), openSupport: jest.fn(), serviceAvailable: true, appVersion: '1.0.0',
    },
    analysis: { state: { result: validFixture }, commands: { reset: jest.fn() } } as any,
    history: {
      status: 'ready', reports, error: null, load: jest.fn(),
      get: jest.fn(async () => validFixture), saveCurrent: jest.fn(),
      delete: jest.fn(), deleteAll: jest.fn(),
    } as any,
  };
  const exporter: ReportExporterPort = {
    cleanupAbandoned: jest.fn(async () => 0),
    export: jest.fn(async () => ({ numberOfPages: 1 })),
    share: jest.fn(async () => undefined),
    discard: jest.fn(async () => undefined),
  };
  const onUpgrade = jest.fn();
  const view = render(
    <AppControllerProvider value={values}>
      <ResultsScreen entitlementActive={false} exporter={exporter} onUpgrade={onUpgrade} />
    </AppControllerProvider>,
  );

  await waitFor(() => expect(view.getByRole('button', { name: 'Save locally' })).toBeTruthy());
  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Save locally' })); });
  expect(values.history.saveCurrent).not.toHaveBeenCalled();
  expect(onUpgrade).toHaveBeenCalledTimes(1);

  await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Unlock PDF report' })); });
  expect(exporter.export).not.toHaveBeenCalled();
  expect(exporter.share).not.toHaveBeenCalled();
  expect(onUpgrade).toHaveBeenCalledTimes(2);
});
