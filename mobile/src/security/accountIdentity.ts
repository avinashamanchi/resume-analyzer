import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import { ResumeApiError } from '../domain/errors';

export const ACCOUNT_IDENTITY_KEY = 'resume-ai.account-identity.v1';

const AccountIdentitySchema = z
  .object({
    accountToken: z.string().min(1).max(2_048),
    expiresAt: z.string().datetime({ offset: false, precision: 0 }),
    revenueCatAppUserId: z.string().regex(/^rai_account_[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export type AccountIdentity = Readonly<z.infer<typeof AccountIdentitySchema>>;

export type AccountIdentityStoreOptions = Readonly<{
  now?: () => number;
}>;

function parseCurrentIdentity(value: unknown, now: number): AccountIdentity | null {
  const parsed = AccountIdentitySchema.safeParse(value);
  if (!parsed.success) return null;
  const expiresAt = Date.parse(parsed.data.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return Object.freeze(parsed.data);
}

export class AccountIdentityStore {
  private readonly now: () => number;

  constructor(options: AccountIdentityStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async get(): Promise<AccountIdentity | null> {
    let encoded: string | null;
    try {
      encoded = await SecureStore.getItemAsync(ACCOUNT_IDENTITY_KEY);
    } catch {
      throw new ResumeApiError('network');
    }
    if (encoded === null) return null;

    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      decoded = null;
    }
    const identity = parseCurrentIdentity(decoded, this.now());
    if (identity !== null) return identity;

    try {
      await SecureStore.deleteItemAsync(ACCOUNT_IDENTITY_KEY);
    } catch {
      throw new ResumeApiError('network');
    }
    return null;
  }

  async set(identity: AccountIdentity): Promise<void> {
    const parsed = parseCurrentIdentity(identity, this.now());
    if (parsed === null) throw new ResumeApiError('validation');
    try {
      await SecureStore.setItemAsync(ACCOUNT_IDENTITY_KEY, JSON.stringify(parsed), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    } catch {
      throw new ResumeApiError('network');
    }
  }

  async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(ACCOUNT_IDENTITY_KEY);
    } catch {
      throw new ResumeApiError('network');
    }
  }
}
