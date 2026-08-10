jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-device-only',
}));

import * as SecureStore from 'expo-secure-store';

import {
  ACCOUNT_IDENTITY_KEY,
  AccountIdentityStore,
  type AccountIdentity,
} from '../src/security/accountIdentity';


const identity: AccountIdentity = {
  accountToken: 'signed-account-token',
  expiresAt: '2026-08-10T03:00:00Z',
  revenueCatAppUserId: `rai_account_${'a'.repeat(43)}`,
};

beforeEach(() => {
  jest.resetAllMocks();
});

it('stores only the bounded account session fields in device-only SecureStore', async () => {
  const store = new AccountIdentityStore({ now: () => Date.parse('2026-08-10T02:00:00Z') });

  await store.set(identity);

  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    ACCOUNT_IDENTITY_KEY,
    JSON.stringify(identity),
    { keychainAccessible: 'when-unlocked-device-only' },
  );
});

it('returns a current exact session and removes expired or malformed values', async () => {
  const store = new AccountIdentityStore({ now: () => Date.parse('2026-08-10T02:00:00Z') });
  jest.mocked(SecureStore.getItemAsync)
    .mockResolvedValueOnce(JSON.stringify(identity))
    .mockResolvedValueOnce(JSON.stringify({ ...identity, expiresAt: '2026-08-10T01:59:59Z' }))
    .mockResolvedValueOnce(JSON.stringify({ ...identity, appleSubject: 'private-subject' }));

  await expect(store.get()).resolves.toEqual(identity);
  await expect(store.get()).resolves.toBeNull();
  await expect(store.get()).resolves.toBeNull();
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(2);
});

it('rejects extra, invalid, or already-expired session fields before writing', async () => {
  const store = new AccountIdentityStore({ now: () => Date.parse('2026-08-10T02:00:00Z') });

  await expect(store.set({ ...identity, expiresAt: '2026-08-10T01:00:00Z' })).rejects.toThrow();
  await expect(store.set({ ...identity, revenueCatAppUserId: 'attacker-chosen-id' })).rejects.toThrow();
  await expect(store.set({ ...identity, email: 'private@example.test' } as AccountIdentity)).rejects.toThrow();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

it('clears the bounded account session without touching installation identity', async () => {
  const store = new AccountIdentityStore();

  await store.clear();

  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(ACCOUNT_IDENTITY_KEY);
});
