import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import HistoryScreen from '../app/(tabs)/history';
import { AppControllerProvider } from '../src/controllers/AppController';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const actions = {
  pickPdfForDisplay: jest.fn(), resetConsent: jest.fn(), cleanupCache: jest.fn(),
  shareSummary: jest.fn(), openSupport: jest.fn(),
  serviceAvailable: true, appVersion: '1.0.0',
};
const analysis = { state: { result: null }, commands: {} } as any;

describe('native History flow', () => {
  it('directs a person from an empty local history back to Analyze', async () => {
    const history = { status: 'ready', reports: [], error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(), delete: jest.fn(), deleteAll: jest.fn() } as any;
    const view = await render(<AppControllerProvider value={{ actions, analysis, history }}><HistoryScreen /></AppControllerProvider>);
    expect(view.getByText('No saved reports')).toBeTruthy();
    expect(view.getByText(/Reports appear here only after/i)).toBeTruthy();
  });

  it('renders allowlisted report fields and requires delete confirmation', async () => {
    const report = { ...validFixture, id: validFixture.analysisId, title: 'Resume analysis — 2026-08-05', createdAt: '2026-08-05T19:20:30.000Z' };
    const history = { status: 'ready', reports: [report], error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(), delete: jest.fn(), deleteAll: jest.fn() } as any;
    const view = await render(<AppControllerProvider value={{ actions, analysis, history }}><HistoryScreen /></AppControllerProvider>);
    expect(view.getByText(report.title)).toBeTruthy();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: `Delete ${report.title}` })); });
    expect(view.getByRole('alert', { name: 'Delete saved report?' })).toBeTruthy();
    expect(history.delete).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete report' })); });
    expect(history.delete).toHaveBeenCalledWith(report.id);
  });
});
