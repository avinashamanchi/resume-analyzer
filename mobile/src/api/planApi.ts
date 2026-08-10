import { z } from 'zod';

import { validateApiBaseUrl } from './apiBaseUrl';
import { AiAllowanceSchema, PublicErrorSchema } from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';
import { AccountTokenSchema, type AccountIdentity } from '../security/accountIdentity';

const MAX_RESPONSE_BYTES = 65_536;

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export type InstallationIdentity = Readonly<{
  installationToken: string;
  revenueCatAppUserId: string;
}>;

export type InstallationIdentityProvider = Readonly<{
  getOrIssueIdentity(signal: AbortSignal): Promise<InstallationIdentity>;
}>;

export type AccountIdentityReader = Readonly<{
  get(): Promise<AccountIdentity | null>;
}>;

export type VerifiedPlanSnapshot = Readonly<{
  schemaVersion: 2;
  kind: 'free' | 'pro';
  verifiedUntil: string;
  entitlementExpiresAt: string | null;
  allowance: z.infer<typeof AiAllowanceSchema>;
}>;

export type PlanApiOptions = Readonly<{
  apiBaseUrl: string;
  installationTokens: InstallationIdentityProvider;
  accountIdentity: AccountIdentityReader;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}>;

const PlanResponseSchema = z
  .object({
    schemaVersion: z.literal(2),
    plan: z.enum(['free', 'pro']),
    verifiedUntil: z.string().datetime({ offset: false, precision: 0 }),
    entitlementExpiresAt: z.string().datetime({ offset: false, precision: 0 }).nullable(),
    allowance: AiAllowanceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.plan === 'free' && value.entitlementExpiresAt !== null) {
      context.addIssue({ code: 'custom', message: 'free plan cannot expire as Pro' });
    }
    if (value.plan === 'pro' && value.entitlementExpiresAt === null) {
      context.addIssue({ code: 'custom', message: 'Pro plan requires an entitlement expiration' });
    }
  });

const AppleIdentityResponseSchema = z
  .object({
    schemaVersion: z.literal(2),
    accountToken: AccountTokenSchema,
    expiresAt: z.string().datetime({ offset: false, precision: 0 }),
    revenueCatAppUserId: z.string().regex(/^rai_account_[A-Za-z0-9_-]{43}$/),
  })
  .strict();

const InstallationIdentitySchema = z
  .object({
    installationToken: z.string().min(1).max(2_048),
    revenueCatAppUserId: z.string().regex(/^rai_installation_[A-Za-z0-9_-]{43}$/),
  })
  .strict();

class AbortSignalFailure extends Error {}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortSignalFailure());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new AbortSignalFailure());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES) {
      throw new ResumeApiError('invalid_response');
    }
  }

  try {
    if (typeof response.text === 'function') {
      const body = await awaitAbortable(response.text(), signal);
      if (utf8ByteLength(body) > MAX_RESPONSE_BYTES) throw new ResumeApiError('invalid_response');
      return JSON.parse(body) as unknown;
    }
    return await awaitAbortable(response.json(), signal);
  } catch (error) {
    if (error instanceof AbortSignalFailure || error instanceof ResumeApiError) throw error;
    throw new ResumeApiError('invalid_response');
  }
}

export class PlanApi {
  private readonly apiBaseUrl: string;
  private readonly installationTokens: InstallationIdentityProvider;
  private readonly accountIdentity: AccountIdentityReader;
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;

  constructor(options: PlanApiOptions) {
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.installationTokens = options.installationTokens;
    this.accountIdentity = options.accountIdentity;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 30_000) {
      throw new TypeError('A bounded plan request timeout is required.');
    }
  }

  async sync(signal: AbortSignal): Promise<VerifiedPlanSnapshot> {
    const value = await this.request(
      '/v2/entitlements/sync',
      {},
      signal,
      'stored',
    );
    const parsed = PlanResponseSchema.safeParse(value);
    if (!parsed.success) throw new ResumeApiError('invalid_response');
    return Object.freeze({
      schemaVersion: 2 as const,
      kind: parsed.data.plan,
      verifiedUntil: parsed.data.verifiedUntil,
      entitlementExpiresAt: parsed.data.entitlementExpiresAt,
      allowance: Object.freeze(parsed.data.allowance),
    });
  }

  async syncWithAccount(
    accountIdentity: AccountIdentity,
    signal: AbortSignal,
  ): Promise<VerifiedPlanSnapshot> {
    const account = AppleIdentityResponseSchema.safeParse({
      schemaVersion: 2,
      ...accountIdentity,
    });
    if (!account.success) throw new ResumeApiError('validation');
    const value = await this.request(
      '/v2/entitlements/sync',
      {},
      signal,
      Object.freeze({
        accountToken: account.data.accountToken,
        expiresAt: account.data.expiresAt,
        revenueCatAppUserId: account.data.revenueCatAppUserId,
      }),
    );
    const parsed = PlanResponseSchema.safeParse(value);
    if (!parsed.success) throw new ResumeApiError('invalid_response');
    return Object.freeze({
      schemaVersion: 2 as const,
      kind: parsed.data.plan,
      verifiedUntil: parsed.data.verifiedUntil,
      entitlementExpiresAt: parsed.data.entitlementExpiresAt,
      allowance: Object.freeze(parsed.data.allowance),
    });
  }

  async linkApple(
    identityToken: string,
    nonce: string,
    signal: AbortSignal,
  ): Promise<AccountIdentity> {
    if (
      typeof identityToken !== 'string' ||
      identityToken.length < 1 ||
      identityToken.length > 16_384 ||
      typeof nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(nonce)
    ) {
      throw new ResumeApiError('validation');
    }
    const value = await this.request(
      '/v2/identity/apple',
      { identityToken, nonce },
      signal,
      null,
    );
    const parsed = AppleIdentityResponseSchema.safeParse(value);
    if (!parsed.success) throw new ResumeApiError('invalid_response');
    const { accountToken, expiresAt, revenueCatAppUserId } = parsed.data;
    return Object.freeze({ accountToken, expiresAt, revenueCatAppUserId });
  }

  private async request(
    path: string,
    payload: Readonly<Record<string, unknown>>,
    callerSignal: AbortSignal,
    accountSource: 'stored' | AccountIdentity | null,
  ): Promise<unknown> {
    if (callerSignal.aborted) throw new ResumeApiError('cancelled');
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const rawInstallation = await awaitAbortable(
        this.installationTokens.getOrIssueIdentity(controller.signal),
        controller.signal,
      );
      const installation = InstallationIdentitySchema.safeParse(rawInstallation);
      if (!installation.success) throw new ResumeApiError('invalid_response');
      const headers: Record<string, string> = {
        Authorization: `Installation ${installation.data.installationToken}`,
        'Content-Type': 'application/json',
      };
      if (accountSource !== null) {
        const account = accountSource === 'stored'
          ? await awaitAbortable(this.accountIdentity.get(), controller.signal)
          : accountSource;
        if (account !== null) headers['X-Resume-Account'] = account.accountToken;
      }
      if (controller.signal.aborted) throw new AbortSignalFailure();
      const response = await awaitAbortable(
        this.fetchImpl(`${this.apiBaseUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        controller.signal,
      );
      const data = await readBoundedJson(response, controller.signal);
      if (response.status >= 200 && response.status < 300) return data;
      const publicError = PublicErrorSchema.safeParse(data);
      if (!publicError.success) throw new ResumeApiError('invalid_response');
      throw new ResumeApiError('service', publicError.data);
    } catch (error) {
      if (error instanceof ResumeApiError) throw error;
      if (error instanceof AbortSignalFailure || controller.signal.aborted) {
        throw new ResumeApiError(timedOut ? 'timeout' : 'cancelled');
      }
      throw new ResumeApiError('network');
    } finally {
      clearTimeout(timeout);
      callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }
}
