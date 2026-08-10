import { PlanApi, type InstallationIdentityProvider } from '../src/api/planApi';
import type { AccountIdentity } from '../src/security/accountIdentity';


const INSTALLATION_TOKEN = 'signed-installation-token';
const INSTALLATION_APP_USER_ID = `rai_installation_${'i'.repeat(43)}`;
const ACCOUNT_APP_USER_ID = `rai_account_${'a'.repeat(43)}`;
const ACCOUNT_TOKEN = 'eyJ2ZXJzaW9uIjoxfQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const freePlan = {
  schemaVersion: 2,
  plan: 'free',
  verifiedUntil: '2026-08-11T00:00:00Z',
  entitlementExpiresAt: null,
  allowance: { used: 1, limit: 3, resetsAt: '2026-09-01T00:00:00Z' },
};

const accountIdentity: AccountIdentity = {
  accountToken: ACCOUNT_TOKEN,
  expiresAt: '2026-08-10T03:00:00Z',
  revenueCatAppUserId: ACCOUNT_APP_USER_ID,
};

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function harness(account: AccountIdentity | null = null) {
  const installationTokens: InstallationIdentityProvider = {
    getOrIssueIdentity: jest.fn(async () => ({
      installationToken: INSTALLATION_TOKEN,
      revenueCatAppUserId: INSTALLATION_APP_USER_ID,
    })),
  };
  const accountIdentityStore = {
    get: jest.fn(async () => account),
  };
  const fetchImpl = jest.fn();
  const api = new PlanApi({
    apiBaseUrl: 'https://api.example.test',
    installationTokens,
    accountIdentity: accountIdentityStore,
    fetchImpl,
    timeoutMs: 1_000,
  });
  return { api, installationTokens, accountIdentityStore, fetchImpl };
}

it('accepts only the server plan as access proof and binds sync to installation identity', async () => {
  const { api, fetchImpl } = harness();
  fetchImpl.mockResolvedValue(response(200, freePlan));

  await expect(api.sync(new AbortController().signal)).resolves.toEqual({
    schemaVersion: 2,
    kind: 'free',
    verifiedUntil: '2026-08-11T00:00:00Z',
    entitlementExpiresAt: null,
    allowance: { used: 1, limit: 3, resetsAt: '2026-09-01T00:00:00Z' },
  });
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://api.example.test/v2/entitlements/sync',
    expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: `Installation ${INSTALLATION_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
  );
});

it('adds only a current store-validated account token to entitlement sync', async () => {
  const { api, fetchImpl } = harness(accountIdentity);
  fetchImpl.mockResolvedValue(response(200, {
    ...freePlan,
    plan: 'pro',
    verifiedUntil: '2026-08-11T00:00:00Z',
    entitlementExpiresAt: '2026-09-10T00:00:00Z',
    allowance: { used: 4, limit: 100, resetsAt: '2026-09-01T00:00:00Z' },
  }));

  await expect(api.sync(new AbortController().signal)).resolves.toMatchObject({
    kind: 'pro',
    allowance: { used: 4, limit: 100 },
  });
  expect(fetchImpl.mock.calls[0][1].headers).toEqual({
    Authorization: `Installation ${INSTALLATION_TOKEN}`,
    'Content-Type': 'application/json',
    'X-Resume-Account': ACCOUNT_TOKEN,
  });
});

it('can verify a just-issued Apple account before persisting it', async () => {
  const { api, fetchImpl, accountIdentityStore } = harness();
  fetchImpl.mockResolvedValue(response(200, {
    ...freePlan,
    plan: 'pro',
    entitlementExpiresAt: '2026-09-10T00:00:00Z',
    allowance: { used: 4, limit: 100, resetsAt: '2026-09-01T00:00:00Z' },
  }));

  await expect(api.syncWithAccount(
    accountIdentity,
    new AbortController().signal,
  )).resolves.toMatchObject({ kind: 'pro' });
  expect(accountIdentityStore.get).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
    'X-Resume-Account': ACCOUNT_TOKEN,
  });
});

it('links Apple with the raw nonce without persisting token or Apple profile data', async () => {
  const { api, fetchImpl } = harness();
  fetchImpl.mockResolvedValue(response(200, {
    schemaVersion: 2,
    accountToken: ACCOUNT_TOKEN,
    expiresAt: '2026-08-10T03:00:00Z',
    revenueCatAppUserId: ACCOUNT_APP_USER_ID,
  }));

  await expect(api.linkApple(
    'apple-identity-token',
    'raw-one-use-nonce',
    new AbortController().signal,
  )).resolves.toEqual(accountIdentity);
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://api.example.test/v2/identity/apple',
    expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: `Installation ${INSTALLATION_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        identityToken: 'apple-identity-token',
        nonce: 'raw-one-use-nonce',
      }),
    }),
  );
});

it('fails closed on malformed, oversized, non-200, or aborted responses', async () => {
  const malformed = harness();
  malformed.fetchImpl.mockResolvedValue(response(200, { ...freePlan, extra: true }));
  await expect(malformed.api.sync(new AbortController().signal)).rejects.toMatchObject({
    category: 'invalid_response',
  });

  const oversized = harness();
  oversized.fetchImpl.mockResolvedValue(response(200, freePlan, { 'content-length': '65537' }));
  await expect(oversized.api.sync(new AbortController().signal)).rejects.toMatchObject({
    category: 'invalid_response',
  });

  const failed = harness();
  failed.fetchImpl.mockResolvedValue(response(503, {
    schemaVersion: 1,
    code: 'service_unavailable',
    message: 'The service is temporarily unavailable.',
    requestId: '6ef499c6-a2c7-4314-b88b-af45c53da38a',
    retryable: true,
  }));
  await expect(failed.api.sync(new AbortController().signal)).rejects.toMatchObject({
    category: 'service',
    retryable: true,
  });

  const aborted = harness();
  const controller = new AbortController();
  controller.abort();
  await expect(aborted.api.sync(controller.signal)).rejects.toMatchObject({
    category: 'cancelled',
  });
  expect(aborted.fetchImpl).not.toHaveBeenCalled();
});
