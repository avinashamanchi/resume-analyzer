jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-device-only',
}));

jest.mock('expo-sqlite/kv-store', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

import * as SecureStore from 'expo-secure-store';

import { CONSENT_VERSION, ConsentStore } from '../src/security/consentStore';
import {
  INSTALLATION_TOKEN_KEY,
  InstallationTokenStore,
} from '../src/security/installationToken';

const fetchMock = jest.fn();

function response(status: number, data: unknown) {
  return {
    status,
    json: jest.fn().mockResolvedValue(data),
  } as unknown as Response;
}

describe('installation token boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  });

  it('stores only the signed installation token in device-only SecureStore', async () => {
    const store = new InstallationTokenStore({
      apiBaseUrl: 'https://api.example.test',
      fetchImpl: fetchMock,
    });

    await store.save('signed-token');

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      INSTALLATION_TOKEN_KEY,
      'signed-token',
      expect.objectContaining({ keychainAccessible: 'when-unlocked-device-only' }),
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('issues once for concurrent callers and persists only while a caller remains current', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    const store = new InstallationTokenStore({
      apiBaseUrl: 'https://api.example.test',
      fetchImpl: fetchMock,
    });
    const cancelledCaller = new AbortController();
    const waitingCaller = new AbortController();

    const cancelled = store.getOrIssue(cancelledCaller.signal);
    const waiting = store.getOrIssue(waitingCaller.signal);
    await Promise.resolve();
    await Promise.resolve();
    cancelledCaller.abort();
    resolveFetch?.(response(201, { schemaVersion: 1, installationToken: 'signed-token' }));

    await expect(cancelled).rejects.toMatchObject({ category: 'cancelled' });
    await expect(waiting).resolves.toBe('signed-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('does not persist a late issuance after every caller cancels', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    const store = new InstallationTokenStore({
      apiBaseUrl: 'https://api.example.test',
      fetchImpl: fetchMock,
    });
    const caller = new AbortController();
    const pending = store.getOrIssue(caller.signal);
    await Promise.resolve();
    await Promise.resolve();
    caller.abort();
    resolveFetch?.(response(201, { schemaVersion: 1, installationToken: 'signed-token' }));

    await expect(pending).rejects.toMatchObject({ category: 'cancelled' });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('does not save malformed issuance responses and supports explicit invalidation', async () => {
    fetchMock.mockResolvedValue(response(201, { schemaVersion: 1, installationToken: 'token', extra: true }));
    const store = new InstallationTokenStore({
      apiBaseUrl: 'https://api.example.test',
      fetchImpl: fetchMock,
    });

    await expect(store.getOrIssue(new AbortController().signal)).rejects.toMatchObject({
      category: 'invalid_response',
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();

    await store.clear();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(INSTALLATION_TOKEN_KEY);
  });
});

describe('versioned consent boundary', () => {
  const keyValueStore = () => ({
    getItem: jest.fn<Promise<string | null>, [string]>(),
    setItem: jest.fn<Promise<void>, [string, string]>(),
    removeItem: jest.fn<Promise<void>, [string]>(),
  });

  it('stores only consent version/state outside SecureStore', async () => {
    const storage = keyValueStore();
    const store = new ConsentStore(storage);

    await store.grant();

    expect(storage.setItem).toHaveBeenCalledWith(
      'resume-ai.consent.v1',
      JSON.stringify({ state: 'accepted', version: CONSENT_VERSION }),
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('requires fresh consent after a consent-version change', async () => {
    const storage = keyValueStore();
    storage.getItem.mockResolvedValue(JSON.stringify({ state: 'accepted', version: '2026-08-03.v1' }));
    const store = new ConsentStore(storage);

    await expect(store.hasCurrentConsent()).resolves.toBe(false);
  });
});
