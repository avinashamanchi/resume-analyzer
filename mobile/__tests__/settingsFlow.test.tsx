import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import SettingsScreen from '../app/(tabs)/settings';
import PrivacyScreen from '../app/privacy';
import SupportScreen from '../app/support';
import { AppControllerProvider } from '../src/controllers/AppController';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

function values() {
  return {
    actions: {
      pickPdfForDisplay: jest.fn(),
      resetConsent: jest.fn(async () => undefined),
      cleanupCache: jest.fn(async () => ({ verified: true, deletedFiles: 1 })),
      shareSummary: jest.fn(), openSupport: jest.fn(async () => undefined), serviceAvailable: true, appVersion: '1.0.0',
    },
    analysis: { state: { result: null }, commands: {} } as any,
    history: { status: 'ready', reports: [], error: null, load: jest.fn(), get: jest.fn(), saveCurrent: jest.fn(), delete: jest.fn(), deleteAll: jest.fn(async () => ({ deletedReports: 2, deletedTempFiles: 0, failures: 0 })) } as any,
  };
}

describe('native Settings, privacy, and support flows', () => {
  it('requires exact DELETE plus a second confirmation before delete all', async () => {
    const context = values();
    const view = await render(<AppControllerProvider value={context}><SettingsScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.changeText(view.getByLabelText('Type DELETE to delete all saved reports'), 'delete'); });
    expect(view.getByRole('button', { name: 'Delete all local reports' }).props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent.changeText(view.getByLabelText('Type DELETE to delete all saved reports'), 'DELETE'); });
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Delete all local reports' })); });
    expect(context.history.deleteAll).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Confirm delete all' })); });
    await waitFor(() => expect(context.history.deleteAll).toHaveBeenCalledTimes(1));
  });

  it('reports verified cache cleanup and never turns refused cleanup into success', async () => {
    const context = values();
    context.actions.cleanupCache.mockResolvedValueOnce({ verified: false, deletedFiles: 0 });
    const view = await render(<AppControllerProvider value={context}><SettingsScreen /></AppControllerProvider>);
    await act(async () => { fireEvent.press(view.getByRole('button', { name: 'Clean temporary files' })); });
    await waitFor(() => expect(view.getByText('Temporary files could not be verified as clean.')).toBeTruthy());
    expect(view.queryByText('Temporary files are clean.')).toBeNull();
  });

  it('states local and transient boundaries without account claims', async () => {
    const context = values();
    const privacy = await render(<AppControllerProvider value={context}><PrivacyScreen /></AppControllerProvider>);
    const support = await render(<AppControllerProvider value={context}><SupportScreen /></AppControllerProvider>);
    expect(privacy.getByText(/Reports are saved only on this device/i)).toBeTruthy();
    expect(privacy.getByText(/Groq/i)).toBeTruthy();
    expect(privacy.queryByText(/delete account|cloud history/i)).toBeNull();
    await act(async () => { fireEvent.press(support.getByRole('button', { name: 'Open public support' })); });
    expect(context.actions.openSupport).toHaveBeenCalledTimes(1);
  });
});
