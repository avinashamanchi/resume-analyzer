import type { AccountIdentity } from '../security/accountIdentity';
import type { BillingSnapshot } from './revenueCatService';
import { BillingUnavailableError } from './revenueCatService';
import type { VerifiedPlanSnapshot } from '../api/planApi';

type AppleCredential = Readonly<{ identityToken: string | null }>;

export type AppleAuthenticationPort = Readonly<{
  isAvailableAsync(): Promise<boolean>;
  signInAsync(options: Readonly<{ nonce: string }>): Promise<AppleCredential>;
}>;

export type ApplePlanApi = Readonly<{
  linkApple(identityToken: string, nonce: string, signal: AbortSignal): Promise<AccountIdentity>;
  syncWithAccount(account: AccountIdentity, signal: AbortSignal): Promise<VerifiedPlanSnapshot>;
}>;

export type AppleAccountLinkerOptions = Readonly<{
  apple?: AppleAuthenticationPort;
  planApi: ApplePlanApi;
  accountStore: Readonly<{ set(identity: AccountIdentity): Promise<void> }>;
  billing: Readonly<{
    linkAccount(
      appUserId: string,
      verify: () => Promise<VerifiedPlanSnapshot>,
    ): Promise<BillingSnapshot>;
  }>;
  nonce?: () => Promise<Readonly<{ raw: string; digest: string }>>;
}>;

export class AppleSignInCancelledError extends Error {
  constructor() {
    super('Sign in with Apple was cancelled.');
    this.name = 'AppleSignInCancelledError';
  }
}

export class AppleSignInUnavailableError extends Error {
  constructor() {
    super('Sign in with Apple is unavailable.');
    this.name = 'AppleSignInUnavailableError';
  }
}

const defaultApple: AppleAuthenticationPort = {
  async isAvailableAsync() {
    const apple = await import('expo-apple-authentication');
    return apple.isAvailableAsync();
  },
  async signInAsync(options) {
    const apple = await import('expo-apple-authentication');
    return apple.signInAsync(options);
  },
};

async function defaultNonce(): Promise<Readonly<{ raw: string; digest: string }>> {
  const crypto = await import('expo-crypto');
  const bytes = await crypto.getRandomBytesAsync(32);
  const raw = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const digest = await crypto.digestStringAsync(
    crypto.CryptoDigestAlgorithm.SHA256,
    raw,
    { encoding: crypto.CryptoEncoding.HEX },
  );
  return Object.freeze({ raw, digest });
}

function isCancellation(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ERR_REQUEST_CANCELED' || error.code === 'ERR_CANCELED';
}

function assertCurrent(signal: AbortSignal): void {
  if (signal.aborted) throw new AppleSignInCancelledError();
}

export class AppleAccountLinker {
  private readonly apple: AppleAuthenticationPort;
  private readonly nonce: () => Promise<Readonly<{ raw: string; digest: string }>>;

  constructor(private readonly options: AppleAccountLinkerOptions) {
    this.apple = options.apple ?? defaultApple;
    this.nonce = options.nonce ?? defaultNonce;
  }

  async link(signal: AbortSignal): Promise<BillingSnapshot> {
    assertCurrent(signal);
    if (!(await this.apple.isAvailableAsync())) throw new AppleSignInUnavailableError();
    assertCurrent(signal);

    const nonce = await this.nonce();
    if (
      !/^[A-Za-z0-9_-]{16,256}$/.test(nonce.raw) ||
      !/^[a-f0-9]{64}$/.test(nonce.digest)
    ) {
      throw new BillingUnavailableError();
    }

    let credential: AppleCredential;
    try {
      credential = await this.apple.signInAsync({ nonce: nonce.digest });
    } catch (error) {
      if (isCancellation(error)) throw new AppleSignInCancelledError();
      throw new BillingUnavailableError();
    }
    assertCurrent(signal);
    if (
      typeof credential.identityToken !== 'string' ||
      credential.identityToken.length < 1 ||
      credential.identityToken.length > 16_384
    ) {
      throw new BillingUnavailableError();
    }

    const account = await this.options.planApi.linkApple(
      credential.identityToken,
      nonce.raw,
      signal,
    );
    assertCurrent(signal);
    const snapshot = await this.options.billing.linkAccount(
      account.revenueCatAppUserId,
      () => this.options.planApi.syncWithAccount(account, signal),
    );
    assertCurrent(signal);
    // A successful RevenueCat transfer followed by a backend outage must stay
    // retryable under the account identity. This bounded token never grants
    // access by itself; only a later verified plan can do that.
    if (
      (snapshot.planStatus === 'pro_verified' && snapshot.entitlementActive) ||
      snapshot.planStatus === 'pro_verification_needed'
    ) {
      await this.options.accountStore.set(account);
    }
    return snapshot;
  }
}
