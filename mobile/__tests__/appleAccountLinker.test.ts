import {
  AppleAccountLinker,
  AppleSignInCancelledError,
} from '../src/billing/appleAccountLinker';

const account = {
  accountToken: 'signed-account-token',
  expiresAt: '2099-08-10T03:00:00Z',
  revenueCatAppUserId: `rai_account_${'a'.repeat(43)}`,
};

const proPlan = {
  schemaVersion: 2 as const,
  kind: 'pro' as const,
  verifiedUntil: '2099-08-11T00:00:00Z',
  entitlementExpiresAt: '2099-09-10T00:00:00Z',
  allowance: { used: 4, limit: 100 as const, resetsAt: '2099-09-01T00:00:00Z' },
};

it('hashes a one-use nonce for Apple and persists only after server-verified account restore', async () => {
  const apple = {
    isAvailableAsync: jest.fn(async () => true),
    signInAsync: jest.fn(async () => ({ identityToken: 'apple-identity-token' })),
  };
  const planApi = {
    linkApple: jest.fn(async () => account),
    syncWithAccount: jest.fn(async () => proPlan),
  };
  const accountStore = { set: jest.fn(async () => undefined) };
  const billing = {
    linkAccount: jest.fn(async (_id: string, verify: () => Promise<typeof proPlan>) => {
      const verified = await verify();
      return {
        availability: 'ready' as const,
        planStatus: 'pro_verified' as const,
        entitlementActive: verified.kind === 'pro',
        allowance: verified.allowance,
        products: [],
      };
    }),
  };
  const linker = new AppleAccountLinker({
    apple,
    planApi,
    accountStore,
    billing,
    nonce: jest.fn(async () => ({ raw: 'raw-one-use-nonce', digest: 'd'.repeat(64) })),
  });

  await expect(linker.link(new AbortController().signal)).resolves.toMatchObject({
    planStatus: 'pro_verified',
    entitlementActive: true,
  });
  expect(apple.signInAsync).toHaveBeenCalledWith({ nonce: 'd'.repeat(64) });
  expect(planApi.linkApple).toHaveBeenCalledWith(
    'apple-identity-token',
    'raw-one-use-nonce',
    expect.any(AbortSignal),
  );
  expect(billing.linkAccount).toHaveBeenCalledWith(account.revenueCatAppUserId, expect.any(Function));
  expect(planApi.syncWithAccount).toHaveBeenCalledWith(account, expect.any(AbortSignal));
  expect(accountStore.set).toHaveBeenCalledWith(account);
});

it('does not persist identity when verification is free or Apple is cancelled', async () => {
  const apple = {
    isAvailableAsync: jest.fn(async () => true),
    signInAsync: jest.fn()
      .mockResolvedValueOnce({ identityToken: 'apple-identity-token' })
      .mockRejectedValueOnce({ code: 'ERR_REQUEST_CANCELED' }),
  };
  const freePlan = {
    ...proPlan,
    kind: 'free' as const,
    entitlementExpiresAt: null,
    allowance: { used: 1, limit: 3 as const, resetsAt: '2099-09-01T00:00:00Z' },
  };
  const accountStore = { set: jest.fn(async () => undefined) };
  const linker = new AppleAccountLinker({
    apple,
    planApi: {
      linkApple: jest.fn(async () => account),
      syncWithAccount: jest.fn(async () => freePlan),
    },
    accountStore,
    billing: {
      linkAccount: jest.fn(async (_id: string, verify: () => Promise<typeof freePlan>) => {
        const verified = await verify();
        return {
          availability: 'ready' as const,
          planStatus: 'free' as const,
          entitlementActive: false,
          allowance: verified.allowance,
          products: [],
        };
      }),
    },
    nonce: jest.fn(async () => ({ raw: 'raw-one-use-nonce', digest: 'd'.repeat(64) })),
  });

  await expect(linker.link(new AbortController().signal)).resolves.toMatchObject({
    planStatus: 'free',
  });
  expect(accountStore.set).not.toHaveBeenCalled();
  await expect(linker.link(new AbortController().signal)).rejects.toBeInstanceOf(
    AppleSignInCancelledError,
  );
  expect(accountStore.set).not.toHaveBeenCalled();
});

it('keeps a post-transfer verification outage retryable without granting Pro', async () => {
  const accountStore = { set: jest.fn(async () => undefined) };
  const linker = new AppleAccountLinker({
    apple: {
      isAvailableAsync: jest.fn(async () => true),
      signInAsync: jest.fn(async () => ({ identityToken: 'apple-identity-token' })),
    },
    planApi: {
      linkApple: jest.fn(async () => account),
      syncWithAccount: jest.fn(async () => proPlan),
    },
    accountStore,
    billing: {
      linkAccount: jest.fn(async () => ({
        availability: 'error' as const,
        planStatus: 'pro_verification_needed' as const,
        entitlementActive: false,
        allowance: null,
        products: [],
      })),
    },
    nonce: jest.fn(async () => ({ raw: 'raw-one-use-nonce', digest: 'd'.repeat(64) })),
  });

  await expect(linker.link(new AbortController().signal)).resolves.toMatchObject({
    planStatus: 'pro_verification_needed',
    entitlementActive: false,
  });
  expect(accountStore.set).toHaveBeenCalledWith(account);
});
