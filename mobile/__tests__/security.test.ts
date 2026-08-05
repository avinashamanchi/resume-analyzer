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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settlePromptly<T>(promise: Promise<T>): Promise<
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<{ state: 'pending' }>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), 25);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ state: 'fulfilled' as const, value }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      ),
      pending,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForMockCalls(mock: { mock: { calls: unknown[][] } }, minimum = 1): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length >= minimum) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Expected mocked operation to start.');
}

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
    await waitForMockCalls(fetchMock);
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
    await waitForMockCalls(fetchMock);
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

  it('cancels a hanging SecureStore read promptly and lets a later caller issue a token', async () => {
    const blockedRead = deferred<string | null>();
    jest.mocked(SecureStore.getItemAsync)
      .mockImplementationOnce(() => blockedRead.promise)
      .mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    const store = new InstallationTokenStore({ apiBaseUrl: 'https://api.example.test', fetchImpl: fetchMock });
    const firstController = new AbortController();
    const first = store.getOrIssue(firstController.signal);
    await flushAsync();
    firstController.abort();

    await expect(settlePromptly(first)).resolves.toMatchObject({
      state: 'rejected',
      error: { category: 'cancelled' },
    });
    await expect(settlePromptly(store.getOrIssue(new AbortController().signal))).resolves.toEqual({
      state: 'fulfilled',
      value: 'fresh-token',
    });
  });

  it('detaches an issuance with a hanging response body after cancellation so a later caller starts fresh', async () => {
    const blockedBody = deferred<unknown>();
    fetchMock
      .mockResolvedValueOnce({ status: 201, json: jest.fn(() => blockedBody.promise) } as unknown as Response)
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    const store = new InstallationTokenStore({ apiBaseUrl: 'https://api.example.test', fetchImpl: fetchMock });
    const firstController = new AbortController();
    const first = store.getOrIssue(firstController.signal);
    await flushAsync();
    firstController.abort();

    await expect(settlePromptly(first)).resolves.toMatchObject({
      state: 'rejected',
      error: { category: 'cancelled' },
    });
    await expect(settlePromptly(store.getOrIssue(new AbortController().signal))).resolves.toEqual({
      state: 'fulfilled',
      value: 'fresh-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('detaches a hanging token save after cancellation and does not let it poison a later issuance', async () => {
    const blockedSave = deferred<void>();
    fetchMock
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'stale-token' }))
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    jest.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(() => blockedSave.promise)
      .mockResolvedValueOnce(undefined);
    const store = new InstallationTokenStore({ apiBaseUrl: 'https://api.example.test', fetchImpl: fetchMock });
    const firstController = new AbortController();
    const first = store.getOrIssue(firstController.signal);
    await waitForMockCalls(jest.mocked(SecureStore.setItemAsync));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      INSTALLATION_TOKEN_KEY,
      'stale-token',
      expect.any(Object),
    );
    firstController.abort();

    await expect(settlePromptly(first)).resolves.toMatchObject({
      state: 'rejected',
      error: { category: 'cancelled' },
    });
    await expect(settlePromptly(store.getOrIssue(new AbortController().signal))).resolves.toEqual({
      state: 'fulfilled',
      value: 'fresh-token',
    });
    blockedSave.resolve();
    await flushAsync();
    await expect(settlePromptly(store.getOrIssue(new AbortController().signal))).resolves.toEqual({
      state: 'fulfilled',
      value: 'fresh-token',
    });
  });

  it('keeps the fresh logical token authoritative across delayed stale save and clear operations', async () => {
    const oldSave = deferred<void>();
    const oldClear = deferred<void>();
    let persisted: string | null = null;
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async () => persisted);
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (_key, value) => {
      if (value === 'stale-token') {
        await oldSave.promise;
        persisted = value;
        return;
      }
      persisted = value;
    });
    jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      await oldClear.promise;
      persisted = null;
    });
    fetchMock
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'stale-token' }))
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    const store = new InstallationTokenStore({ apiBaseUrl: 'https://api.example.test', fetchImpl: fetchMock });
    const firstController = new AbortController();
    const first = store.getOrIssue(firstController.signal);
    await waitForMockCalls(jest.mocked(SecureStore.setItemAsync));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      INSTALLATION_TOKEN_KEY,
      'stale-token',
      expect.any(Object),
    );
    const staleClear = store.clear();
    firstController.abort();
    await expect(settlePromptly(first)).resolves.toMatchObject({
      state: 'rejected',
      error: { category: 'cancelled' },
    });

    await expect(settlePromptly(store.getOrIssue(new AbortController().signal))).resolves.toEqual({
      state: 'fulfilled',
      value: 'fresh-token',
    });
    oldSave.resolve();
    oldClear.resolve();
    await staleClear;
    await flushAsync();

    await expect(store.getOrIssue(new AbortController().signal)).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('versioned consent boundary', () => {
  const keyValueStore = () => ({
    getItem: jest.fn<Promise<string | null>, [string]>(),
    setItem: jest.fn<Promise<void>, [string, string]>(),
    removeItem: jest.fn<Promise<void>, [string]>(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
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
