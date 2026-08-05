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

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import * as SecureStore from 'expo-secure-store';
import { openDatabaseAsync } from 'expo-sqlite';

import { ResumeApi } from '../src/api/resumeApi';
import { CONSENT_VERSION, ConsentStore } from '../src/security/consentStore';
import {
  INSTALLATION_TOKEN_KEY,
  InstallationTokenStore,
} from '../src/security/installationToken';
import { SQLiteTokenAuthorityStore } from '../src/security/tokenAuthority';

const fetchMock = jest.fn();

type AuthorityState = {
  nextGeneration: number;
  activeGeneration: number | null;
  pendingGeneration: number | null;
};

type TestAuthorityStore = {
  read(): Promise<AuthorityState>;
  reserve(): Promise<number>;
  finalize(generation: number): Promise<{ activated: boolean; replacedGeneration: number | null }>;
  retire(generation: number): Promise<boolean>;
  retireAll(): Promise<number[]>;
  snapshot(): AuthorityState;
};

const tokenSlot = (generation: number) => `resume-ai.installation-token.v1.g${generation}`;

function authorityStore(initial: Partial<AuthorityState> = {}): TestAuthorityStore {
  let state: AuthorityState = {
    nextGeneration: initial.nextGeneration ?? 1,
    activeGeneration: initial.activeGeneration ?? null,
    pendingGeneration: initial.pendingGeneration ?? null,
  };
  return {
    async read() {
      return { ...state };
    },
    async reserve() {
      const generation = state.nextGeneration;
      state = { ...state, nextGeneration: generation + 1, pendingGeneration: generation };
      return generation;
    },
    async finalize(generation) {
      if (state.pendingGeneration !== generation) {
        return { activated: false, replacedGeneration: state.activeGeneration };
      }
      const replacedGeneration = state.activeGeneration;
      state = { ...state, activeGeneration: generation, pendingGeneration: null };
      return { activated: true, replacedGeneration };
    },
    async retire(generation) {
      const wasCurrent = state.activeGeneration === generation || state.pendingGeneration === generation;
      state = {
        ...state,
        activeGeneration: state.activeGeneration === generation ? null : state.activeGeneration,
        pendingGeneration: state.pendingGeneration === generation ? null : state.pendingGeneration,
      };
      return wasCurrent;
    },
    async retireAll() {
      const generations = [state.activeGeneration, state.pendingGeneration].filter(
        (generation): generation is number => generation !== null,
      );
      state = { ...state, activeGeneration: null, pendingGeneration: null };
      return generations;
    },
    snapshot() {
      return { ...state };
    },
  };
}

function createTokenStore(
  authority = authorityStore(),
  options: Partial<ConstructorParameters<typeof InstallationTokenStore>[0]> = {},
) {
  return {
    authority,
    store: new InstallationTokenStore({
      apiBaseUrl: 'https://api.example.test',
      fetchImpl: fetchMock,
      authorityStore: authority,
      ...options,
    } as ConstructorParameters<typeof InstallationTokenStore>[0]),
  };
}

function createApiForTokenStore(store: InstallationTokenStore, fetchImpl: jest.Mock = jest.fn()) {
  return new ResumeApi({
    apiBaseUrl: 'https://api.example.test',
    installationTokens: store,
    fetchImpl,
    timeoutMs: 10,
    requestId: () => 'd2719b54-1e17-4c9f-b85f-7e510a0af30b',
  });
}

function analyzeWithTokenStore(api: ResumeApi): Promise<unknown> {
  return api.analyze(
    { source: { kind: 'text', text: 'Resume' }, consentVersion: '2026-08-04.v1' },
    new AbortController().signal,
  );
}

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

async function outcomeAfterMicrotasks<T>(promise: Promise<T>): Promise<
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' }
> {
  let outcome:
    | { state: 'fulfilled'; value: T }
    | { state: 'rejected'; error: unknown }
    | undefined;
  void promise.then(
    (value) => { outcome = { state: 'fulfilled', value }; },
    (error: unknown) => { outcome = { state: 'rejected', error }; },
  );
  for (let turn = 0; turn < 12 && outcome === undefined; turn += 1) {
    await Promise.resolve();
  }
  return outcome ?? { state: 'pending' };
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

function secureTokenSlots(initial: Record<string, string> = {}) {
  const slots = new Map(Object.entries(initial));
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => slots.get(key) ?? null);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    slots.set(key, value);
  });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    slots.delete(key);
  });
  return slots;
}

describe('installation token boundary', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  });

  it('stores only the signed installation token in device-only SecureStore', async () => {
    const { store } = createTokenStore();

    await store.save('signed-token');

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      tokenSlot(1),
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
    const { store } = createTokenStore();
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
    const { store } = createTokenStore();
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
    const { store } = createTokenStore();

    await expect(store.getOrIssue(new AbortController().signal)).rejects.toMatchObject({
      category: 'invalid_response',
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'signed-token' }));
    await store.getOrIssue(new AbortController().signal);
    await store.clear();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(tokenSlot(2));
  });

  it('cancels a hanging SecureStore read promptly and lets a later caller issue a token', async () => {
    const blockedRead = deferred<string | null>();
    jest.mocked(SecureStore.getItemAsync)
      .mockImplementationOnce(() => blockedRead.promise)
      .mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    const { store } = createTokenStore();
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
    blockedRead.resolve(null);
    await flushAsync();
  });

  it('detaches an issuance with a hanging response body after cancellation so a later caller starts fresh', async () => {
    const blockedBody = deferred<unknown>();
    fetchMock
      .mockResolvedValueOnce({ status: 201, json: jest.fn(() => blockedBody.promise) } as unknown as Response)
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    const { store } = createTokenStore();
    const firstController = new AbortController();
    const first = store.getOrIssue(firstController.signal);
    await waitForMockCalls(fetchMock);
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
    blockedBody.resolve({ schemaVersion: 1, installationToken: 'cancelled-token' });
    await flushAsync();
  });

  it('detaches a hanging token save after cancellation and does not let it poison a later issuance', async () => {
    const blockedSave = deferred<void>();
    fetchMock
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'stale-token' }))
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    jest.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(() => blockedSave.promise)
      .mockResolvedValueOnce(undefined);
    const { store } = createTokenStore();
    const firstController = new AbortController();
    const first = store.getOrIssue(firstController.signal);
    await waitForMockCalls(jest.mocked(SecureStore.setItemAsync));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      tokenSlot(1),
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
    const { store } = createTokenStore();
    const firstController = new AbortController();
    const first = store.getOrIssue(firstController.signal);
    await waitForMockCalls(jest.mocked(SecureStore.setItemAsync));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      tokenSlot(1),
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

  it('keeps a fresh durable generation authoritative after an old delayed save completes', async () => {
    const delayedOldSave = deferred<void>();
    const slots = secureTokenSlots();
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === tokenSlot(1) || key === INSTALLATION_TOKEN_KEY) await delayedOldSave.promise;
      slots.set(key, value);
    });
    fetchMock
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'cancelled-token' }))
      .mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    const authority = authorityStore();
    const { store: oldStore } = createTokenStore(authority);
    const oldCaller = new AbortController();
    const oldIssue = oldStore.getOrIssue(oldCaller.signal);
    await waitForMockCalls(jest.mocked(SecureStore.setItemAsync));
    oldCaller.abort();
    await expect(settlePromptly(oldIssue)).resolves.toMatchObject({
      state: 'rejected',
      error: { category: 'cancelled' },
    });

    const { store: freshStore } = createTokenStore(authority);
    await expect(freshStore.getOrIssue(new AbortController().signal)).resolves.toBe('fresh-token');
    delayedOldSave.resolve();
    await flushAsync();

    const { store: restartedStore } = createTokenStore(authority);
    await expect(restartedStore.getOrIssue(new AbortController().signal)).resolves.toBe('fresh-token');
    expect(slots.get(tokenSlot(1))).toBe('cancelled-token');
    expect(slots.get(tokenSlot(2))).toBe('fresh-token');
  });

  it('keeps a fresh durable generation authoritative after an old exact-slot delete completes', async () => {
    const delayedOldDelete = deferred<void>();
    const authority = authorityStore({ nextGeneration: 2, activeGeneration: 1 });
    const slots = secureTokenSlots({
      [INSTALLATION_TOKEN_KEY]: 'old-token',
      [tokenSlot(1)]: 'old-token',
    });
    jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === tokenSlot(1) || key === INSTALLATION_TOKEN_KEY) await delayedOldDelete.promise;
      slots.delete(key);
    });
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    const { store: oldStore } = createTokenStore(authority);
    const delayedClear = oldStore.clear();
    await waitForMockCalls(jest.mocked(SecureStore.deleteItemAsync));

    const { store: freshStore } = createTokenStore(authority);
    await expect(freshStore.getOrIssue(new AbortController().signal)).resolves.toBe('fresh-token');
    delayedOldDelete.resolve();
    await delayedClear;

    const { store: restartedStore } = createTokenStore(authority);
    await expect(restartedStore.getOrIssue(new AbortController().signal)).resolves.toBe('fresh-token');
    expect(slots.get(tokenSlot(2))).toBe('fresh-token');
  });

  it.each([
    ['reserved', { nextGeneration: 2, activeGeneration: null, pendingGeneration: 1 }],
    ['saved but not finalized', { nextGeneration: 2, activeGeneration: null, pendingGeneration: 1 }],
    ['retired', { nextGeneration: 2, activeGeneration: null, pendingGeneration: null }],
  ] as const)('does not accept a %s generation after restart', async (_boundary, state) => {
    const authority = authorityStore(state);
    const slots = secureTokenSlots({
      [INSTALLATION_TOKEN_KEY]: 'cancelled-token',
      [tokenSlot(1)]: 'cancelled-token',
    });
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));

    const { store } = createTokenStore(authority);
    await expect(store.getOrIssue(new AbortController().signal)).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slots.get(tokenSlot(2))).toBe('fresh-token');
  });

  it('accepts only the authority-selected active slot after restart', async () => {
    const authority = authorityStore({ nextGeneration: 3, activeGeneration: 2, pendingGeneration: 1 });
    secureTokenSlots({
      [INSTALLATION_TOKEN_KEY]: 'cancelled-token',
      [tokenSlot(1)]: 'cancelled-token',
      [tokenSlot(2)]: 'active-token',
    });
    const { store } = createTokenStore(authority);

    await expect(store.getOrIssue(new AbortController().signal)).resolves.toBe('active-token');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(tokenSlot(2));
    expect(SecureStore.getItemAsync).not.toHaveBeenCalledWith(tokenSlot(1));
  });

  it('lets a committed finalize win when the caller aborts after the commit point', async () => {
    const authority = authorityStore();
    const originalFinalize = authority.finalize.bind(authority);
    const finalizeStarted = deferred<void>();
    const finishFinalize = deferred<void>();
    authority.finalize = async (generation) => {
      finalizeStarted.resolve();
      await finishFinalize.promise;
      return originalFinalize(generation);
    };
    secureTokenSlots();
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'committed-token' }));
    const { store } = createTokenStore(authority);
    const controller = new AbortController();

    const issue = store.getOrIssue(controller.signal);
    await finalizeStarted.promise;
    controller.abort();

    await expect(settlePromptly(issue)).resolves.toEqual({ state: 'pending' });
    finishFinalize.resolve();
    await expect(issue).resolves.toBe('committed-token');

    const { store: restartedStore } = createTokenStore(authority);
    await expect(restartedStore.getOrIssue(new AbortController().signal)).resolves.toBe('committed-token');
  });

  it('waits to reject a pre-commit cancellation until its generation is durably retired', async () => {
    const authority = authorityStore();
    const originalRetire = authority.retire.bind(authority);
    const retireStarted = deferred<void>();
    const finishRetire = deferred<void>();
    authority.retire = async (generation) => {
      retireStarted.resolve();
      await finishRetire.promise;
      return originalRetire(generation);
    };
    const blockedSave = deferred<void>();
    secureTokenSlots();
    jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(() => blockedSave.promise);
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'cancelled-token' }));
    const { store } = createTokenStore(authority);
    const controller = new AbortController();

    const issue = store.getOrIssue(controller.signal);
    await waitForMockCalls(jest.mocked(SecureStore.setItemAsync));
    controller.abort();

    await expect(settlePromptly(issue)).resolves.toEqual({ state: 'pending' });
    await retireStarted.promise;
    finishRetire.resolve();
    await expect(issue).rejects.toMatchObject({ category: 'cancelled' });
    expect(authority.snapshot().activeGeneration).toBeNull();

    blockedSave.resolve();
    await flushAsync();
    const { store: restartedStore } = createTokenStore(authority);
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'fresh-token' }));
    await expect(restartedStore.getOrIssue(new AbortController().signal)).resolves.toBe('fresh-token');
  });

  it('rechecks authority after reading a slot and never returns stale A after B replaces it', async () => {
    const authority = authorityStore({ nextGeneration: 2, activeGeneration: 1 });
    const delayedA = deferred<string | null>();
    jest.mocked(SecureStore.getItemAsync)
      .mockImplementationOnce(() => delayedA.promise)
      .mockResolvedValueOnce('token-B');
    const { store } = createTokenStore(authority);

    const read = store.getOrIssue(new AbortController().signal);
    await waitForMockCalls(jest.mocked(SecureStore.getItemAsync));
    const generationB = await authority.reserve();
    await authority.finalize(generationB);
    delayedA.resolve('token-A');

    await expect(read).resolves.toBe('token-B');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a missing active slot when retirement reports a newer authority', async () => {
    const authority = authorityStore({ nextGeneration: 2, activeGeneration: 1 });
    const originalRetire = authority.retire.bind(authority);
    const originalFinalize = authority.finalize.bind(authority);
    authority.retire = async (generation) => {
      if (generation !== 1) return originalRetire(generation);
      const generationB = await authority.reserve();
      await originalFinalize(generationB);
      return false;
    };
    secureTokenSlots({ [tokenSlot(2)]: 'token-B' });
    const { store } = createTokenStore(authority);

    await expect(store.getOrIssue(new AbortController().signal)).resolves.toBe('token-B');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirms authority after finalize and returns a newer committed generation instead of stale A', async () => {
    const authority = authorityStore();
    const originalFinalize = authority.finalize.bind(authority);
    authority.finalize = async (generation) => {
      const result = await originalFinalize(generation);
      if (generation === 1) {
        const generationB = await authority.reserve();
        await originalFinalize(generationB);
      }
      return result;
    };
    secureTokenSlots({ [tokenSlot(2)]: 'token-B' });
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'token-A' }));
    const { store } = createTokenStore(authority);

    await expect(store.getOrIssue(new AbortController().signal)).resolves.toBe('token-B');
    const { store: restartedStore } = createTokenStore(authority);
    await expect(restartedStore.getOrIssue(new AbortController().signal)).resolves.toBe('token-B');
  });

  it('fails closed before storage or network access for corrupt authority metadata', async () => {
    const authority = authorityStore({ nextGeneration: 2, activeGeneration: 0 });
    const { store } = createTokenStore(authority);

    await expect(store.getOrIssue(new AbortController().signal)).rejects.toMatchObject({ category: 'network' });
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['zero active generation', { next_generation: 2, active_generation: 0, pending_generation: null }],
    ['active generation not behind next', { next_generation: 2, active_generation: 2, pending_generation: null }],
    ['equal active and pending generations', { next_generation: 3, active_generation: 2, pending_generation: 2 }],
  ])('fails closed for persisted SQLite authority with %s', async (_caseName, row) => {
    const database = {
      execAsync: jest.fn().mockResolvedValue(undefined),
      getFirstAsync: jest.fn().mockResolvedValue(row),
      runAsync: jest.fn(),
      withExclusiveTransactionAsync: jest.fn(),
    };
    jest.mocked(openDatabaseAsync).mockResolvedValue(database as never);
    const authority = new SQLiteTokenAuthorityStore();

    await expect(authority.read()).rejects.toThrow('Token authority');
  });

  it('bounds a never-settling committed finalize as an indeterminate API outcome', async () => {
    jest.useFakeTimers();
    const authority = authorityStore();
    const finalizeStarted = deferred<void>();
    authority.finalize = async () => {
      finalizeStarted.resolve();
      return new Promise(() => undefined);
    };
    secureTokenSlots();
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'token-A' }));
    const analysisFetch = jest.fn();
    const api = createApiForTokenStore(createTokenStore(authority).store, analysisFetch);

    try {
      const pending = analyzeWithTokenStore(api);
      await finalizeStarted.promise;
      jest.advanceTimersByTime(10);

      await expect(outcomeAfterMicrotasks(pending)).resolves.toMatchObject({
        state: 'rejected',
        error: { category: 'indeterminate', retryable: true },
      });
      expect(analysisFetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a finalize rejection after timeout without starting analysis', async () => {
    jest.useFakeTimers();
    const authority = authorityStore();
    const finalizeStarted = deferred<void>();
    const finalizeGate = deferred<{ activated: boolean; replacedGeneration: number | null }>();
    authority.finalize = async () => {
      finalizeStarted.resolve();
      return finalizeGate.promise;
    };
    secureTokenSlots();
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'token-A' }));
    const analysisFetch = jest.fn();
    const api = createApiForTokenStore(createTokenStore(authority).store, analysisFetch);

    try {
      const pending = analyzeWithTokenStore(api);
      await finalizeStarted.promise;
      jest.advanceTimersByTime(10);
      const outcome = await outcomeAfterMicrotasks(pending);
      finalizeGate.reject(new Error('finalize failed'));
      await flushAsync();

      expect(outcome).toMatchObject({
        state: 'rejected',
        error: { category: 'indeterminate', retryable: true },
      });
      expect(analysisFetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('maps a never-settling pre-commit retirement to the API timeout', async () => {
    jest.useFakeTimers();
    const authority = authorityStore();
    const retireStarted = deferred<void>();
    authority.retire = async () => {
      retireStarted.resolve();
      return new Promise(() => undefined);
    };
    const saveStarted = deferred<void>();
    const blockedSave = deferred<void>();
    secureTokenSlots();
    jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(() => {
      saveStarted.resolve();
      return blockedSave.promise;
    });
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'token-A' }));
    const analysisFetch = jest.fn();
    const api = createApiForTokenStore(createTokenStore(authority).store, analysisFetch);

    try {
      const pending = analyzeWithTokenStore(api);
      await saveStarted.promise;
      jest.advanceTimersByTime(10);
      await retireStarted.promise;

      await expect(outcomeAfterMicrotasks(pending)).resolves.toMatchObject({
        state: 'rejected',
        error: { category: 'timeout' },
      });
      expect(analysisFetch).not.toHaveBeenCalled();
    } finally {
      blockedSave.resolve();
      jest.useRealTimers();
    }
  });

  it('maps a rejected pre-commit retirement to the API timeout', async () => {
    jest.useFakeTimers();
    const authority = authorityStore();
    const retireStarted = deferred<void>();
    const retireGate = deferred<boolean>();
    authority.retire = async () => {
      retireStarted.resolve();
      return retireGate.promise;
    };
    const saveStarted = deferred<void>();
    const blockedSave = deferred<void>();
    secureTokenSlots();
    jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(() => {
      saveStarted.resolve();
      return blockedSave.promise;
    });
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'token-A' }));
    const analysisFetch = jest.fn();
    const api = createApiForTokenStore(createTokenStore(authority).store, analysisFetch);

    try {
      const pending = analyzeWithTokenStore(api);
      await saveStarted.promise;
      jest.advanceTimersByTime(10);
      await retireStarted.promise;
      const outcome = await outcomeAfterMicrotasks(pending);
      retireGate.reject(new Error('retire failed'));
      blockedSave.resolve();
      await flushAsync();

      expect(outcome).toMatchObject({ state: 'rejected', error: { category: 'timeout' } });
      expect(analysisFetch).not.toHaveBeenCalled();
    } finally {
      blockedSave.resolve();
      jest.useRealTimers();
    }
  });

  it('bounds a never-settling post-finalize authority confirmation as indeterminate', async () => {
    jest.useFakeTimers();
    const authority = authorityStore();
    const originalRead = authority.read.bind(authority);
    const confirmationStarted = deferred<void>();
    authority.read = async () => {
      if (authority.snapshot().activeGeneration === 1) {
        confirmationStarted.resolve();
        return new Promise(() => undefined);
      }
      return originalRead();
    };
    secureTokenSlots();
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'token-A' }));
    const analysisFetch = jest.fn();
    const api = createApiForTokenStore(createTokenStore(authority).store, analysisFetch);

    try {
      const pending = analyzeWithTokenStore(api);
      await confirmationStarted.promise;
      jest.advanceTimersByTime(10);

      await expect(outcomeAfterMicrotasks(pending)).resolves.toMatchObject({
        state: 'rejected',
        error: { category: 'indeterminate', retryable: true },
      });
      expect(analysisFetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds a rejected post-finalize authority confirmation without starting analysis', async () => {
    jest.useFakeTimers();
    const authority = authorityStore();
    const originalRead = authority.read.bind(authority);
    const confirmationStarted = deferred<void>();
    const confirmationGate = deferred<AuthorityState>();
    authority.read = async () => {
      if (authority.snapshot().activeGeneration === 1) {
        confirmationStarted.resolve();
        return confirmationGate.promise;
      }
      return originalRead();
    };
    secureTokenSlots();
    fetchMock.mockResolvedValueOnce(response(201, { schemaVersion: 1, installationToken: 'token-A' }));
    const analysisFetch = jest.fn();
    const api = createApiForTokenStore(createTokenStore(authority).store, analysisFetch);

    try {
      const pending = analyzeWithTokenStore(api);
      await confirmationStarted.promise;
      jest.advanceTimersByTime(10);
      const outcome = await outcomeAfterMicrotasks(pending);
      confirmationGate.reject(new Error('confirmation failed'));
      await flushAsync();

      expect(outcome).toMatchObject({
        state: 'rejected',
        error: { category: 'indeterminate', retryable: true },
      });
      expect(analysisFetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let a delayed invalidation for A abort or retire the newer B issuance', async () => {
    const authority = authorityStore({ nextGeneration: 2, activeGeneration: 1 });
    secureTokenSlots({ [tokenSlot(1)]: 'token-A' });
    const delayedB = deferred<Response>();
    fetchMock.mockImplementationOnce(() => delayedB.promise);
    const { store } = createTokenStore(authority);

    await expect(store.getOrIssue(new AbortController().signal)).resolves.toBe('token-A');
    await store.invalidate('token-A');
    const issueB = store.getOrIssue(new AbortController().signal);
    await waitForMockCalls(fetchMock);
    await store.invalidate('token-A');
    delayedB.resolve(response(201, { schemaVersion: 1, installationToken: 'token-B' }));

    await expect(issueB).resolves.toBe('token-B');
    await store.invalidate('token-A');
    const { store: restartedStore } = createTokenStore(authority);
    await expect(restartedStore.getOrIssue(new AbortController().signal)).resolves.toBe('token-B');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
