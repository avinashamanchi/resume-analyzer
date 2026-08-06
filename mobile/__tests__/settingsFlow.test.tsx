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
    const settings = await render(<AppControllerProvider value={context}><SettingsScreen /></AppControllerProvider>);
    expect(settings.getByText(/usage metadata/i)).toBeTruthy();
    expect(settings.getByText(/up to 30 days/i)).toBeTruthy();
    expect(settings.getByText(/Zero Data Retention.*unverified/i)).toBeTruthy();
    expect(settings.getByText(/7, 14, or 30 days/i)).toBeTruthy();
    expect(settings.getByText(/iPhone or iPad backups stored in iCloud or on a Mac or PC/i)).toBeTruthy();
    expect(settings.getByText(/iCloud backups are always encrypted/i)).toBeTruthy();
    expect(settings.getByText(/Computer backups are not encrypted by default.*Encrypt local backup/i)).toBeTruthy();
    expect(settings.getByText(/Restoring an existing backup may restore reports deleted from the active app/i)).toBeTruthy();
    expect(settings.getByText(/Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content/i)).toBeTruthy();
    expect(settings.getByText(/Review generated feedback before saving, sharing, or allowing it to enter device backups/i)).toBeTruthy();
    await act(async () => { settings.unmount(); });
    const privacy = await render(<AppControllerProvider value={context}><PrivacyScreen /></AppControllerProvider>);
    expect(privacy.queryByText(/Reports are saved only on this device/i)).toBeNull();
    expect(privacy.getByText(/iPhone or iPad backups stored in iCloud or on a Mac or PC/i)).toBeTruthy();
    expect(privacy.getByText(/iCloud backups are always encrypted/i)).toBeTruthy();
    expect(privacy.getByText(/Computer backups are not encrypted by default.*Encrypt local backup/i)).toBeTruthy();
    expect(privacy.getByText(/Restoring an existing backup may restore reports deleted from the active app/i)).toBeTruthy();
    expect(privacy.getByText(/Raw\/original PDF bytes, filenames, resume-input fields, job-description-input fields, installation tokens, and request identifiers are not stored in local reports/i)).toBeTruthy();
    expect(privacy.getByText(/Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content/i)).toBeTruthy();
    expect(privacy.getByText(/Review generated feedback before saving, sharing, or allowing it to enter device backups/i)).toBeTruthy();
    expect(privacy.getAllByText(/Groq/i).length).toBeGreaterThan(0);
    expect(privacy.getByText(/The selected PDF is uploaded and processed before temporary cleanup runs/i)).toBeTruthy();
    expect(privacy.getByText(/does not show the analysis as successful and blocks future analysis/i)).toBeTruthy();
    expect(privacy.getByText(/Cleanup cannot undo processing already completed by the Resume\.AI server or Groq/i)).toBeTruthy();
    expect(privacy.queryByText(/processing stops if cleanup cannot be confirmed/i)).toBeNull();
    expect(privacy.queryByText(/delete account|cloud history/i)).toBeNull();
    expect(privacy.getByText(/hosted on Render/i)).toBeTruthy();
    expect(privacy.getByText(/raw PDF bytes are never sent to Groq/i)).toBeTruthy();
    expect(privacy.getByText(/Vision OCR stays on this iPhone until you review the text and consent/i)).toBeTruthy();
    expect(privacy.getByText(/usage metadata/i)).toBeTruthy();
    expect(privacy.getByText(/up to 30 days/i)).toBeTruthy();
    expect(privacy.getByText(/has not verified Zero Data Retention/i)).toBeTruthy();
    expect(privacy.getByText(/7, 14, or 30 days/i)).toBeTruthy();
    expect(privacy.getByText(/provider-side connection and HTTP request metadata/i)).toBeTruthy();
    expect(privacy.getByText(/Device\/IP Data and IP-based geolocation/i)).toBeTruthy();
    expect(privacy.getByText(/coarse pseudonymous rate-limit key/i)).toBeTruthy();
    await act(async () => { privacy.unmount(); });
    const support = await render(<AppControllerProvider value={context}><SupportScreen /></AppControllerProvider>);
    expect(support.getByText('Self-help')).toBeTruthy();
    expect(support.getByText(/Interactive support is not yet available/i)).toBeTruthy();
    expect(support.queryByText(/Public support|Open public support|Helpful details|Include the app version|Open a repository issue|public issue tracker/i)).toBeNull();
    expect(support.getByText(/not an exact ATS or employment prediction/i)).toBeTruthy();
    expect(support.getByText(/no hiring guarantee/i)).toBeTruthy();
    expect(support.getByText(/not professional, legal, or employment advice/i)).toBeTruthy();
    expect(support.getByText(/Never send or publish a resume, job description, token, request identifier, filename, contact detail, or other private data/i)).toBeTruthy();
    expect(support.getByText(/Computer backups are not encrypted by default.*Encrypt local backup/i)).toBeTruthy();
    expect(support.getByText(/Restoring an existing backup may restore reports deleted from the active app/i)).toBeTruthy();
    expect(support.getByText(/Generated feedback and bullet drafts may quote, transform, or restate names, contact information, resume content, or job-description content/i)).toBeTruthy();
    expect(support.getByText(/Review generated feedback before saving, sharing, or allowing it to enter device backups/i)).toBeTruthy();
    await act(async () => { fireEvent.press(support.getByRole('button', { name: 'Open troubleshooting page' })); });
    expect(context.actions.openSupport).toHaveBeenCalledTimes(1);
  });
});
