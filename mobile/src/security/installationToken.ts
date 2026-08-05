import * as SecureStore from 'expo-secure-store';

import { validateApiBaseUrl } from '../api/apiBaseUrl';
import { InstallationResponseSchema, PublicErrorSchema } from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';

export const INSTALLATION_TOKEN_KEY = 'resume-ai.installation-token.v1';

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export type InstallationTokenStoreOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl?: FetchImplementation;
  now?: () => number;
}>;

type InFlightIssue = {
  readonly controller: AbortController;
  readonly callers: Set<symbol>;
  readonly generation: number;
  token: string | null;
  promise: Promise<string>;
};

type LogicalToken = Readonly<{ generation: number; token: string }>;

class AbortSignalFailure extends Error {}

function decodeBase64UrlAscii(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const input = value.replace(/-/g, '+').replace(/_/g, '/');
  let output = '';
  for (let index = 0; index < input.length; index += 4) {
    const first = alphabet.indexOf(input[index]);
    const second = alphabet.indexOf(input[index + 1]);
    const third = input[index + 2] === undefined ? -1 : alphabet.indexOf(input[index + 2]);
    const fourth = input[index + 3] === undefined ? -1 : alphabet.indexOf(input[index + 3]);
    if (first < 0 || second < 0 || third < -1 || fourth < -1) return null;
    const bits = (first << 18) | (second << 12) | (Math.max(third, 0) << 6) | Math.max(fourth, 0);
    output += String.fromCharCode((bits >> 16) & 0xff);
    if (third >= 0) output += String.fromCharCode((bits >> 8) & 0xff);
    if (fourth >= 0) output += String.fromCharCode(bits & 0xff);
  }
  return output;
}

function isExpiredToken(token: string, now: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const payload = decodeBase64UrlAscii(parts[0]);
  if (payload === null) return false;
  try {
    const parsed: unknown = JSON.parse(payload);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      Number.isInteger((parsed as Record<string, unknown>).exp) &&
      now >= Number((parsed as Record<string, unknown>).exp) * 1_000
    );
  } catch {
    return false;
  }
}

function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new AbortSignalFailure());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new AbortSignalFailure());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
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

function asPromise<T>(operation: () => Promise<T> | T): Promise<T> {
  return Promise.resolve().then(operation);
}

export class InstallationTokenStore {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly now: () => number;
  // SecureStore has no CAS: these establish authority only for this process.
  // A delayed native write/delete may affect the single backing key after restart.
  private currentToken: LogicalToken | null = null;
  private generation = 0;
  private inFlight: InFlightIssue | null = null;
  private readonly retiredTokens = new Set<string>();

  constructor(options: InstallationTokenStoreOptions) {
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async save(token: string, signal?: AbortSignal): Promise<void> {
    const parsed = InstallationResponseSchema.safeParse({ schemaVersion: 1, installationToken: token });
    if (!parsed.success) throw new ResumeApiError('validation');
    const write = asPromise(() => SecureStore.setItemAsync(INSTALLATION_TOKEN_KEY, parsed.data.installationToken, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }));
    try {
      await awaitAbortable(write, signal);
    } catch (error) {
      if (error instanceof AbortSignalFailure) throw new ResumeApiError('cancelled');
      throw new ResumeApiError('network');
    }
  }

  async clear(signal?: AbortSignal): Promise<void> {
    this.invalidateLocal();
    const deletion = asPromise(() => SecureStore.deleteItemAsync(INSTALLATION_TOKEN_KEY));
    try {
      await awaitAbortable(deletion, signal);
    } catch (error) {
      if (error instanceof AbortSignalFailure) {
        void deletion.then(() => undefined, () => undefined);
        throw new ResumeApiError('cancelled');
      }
      throw new ResumeApiError('network');
    }
  }

  async invalidate(): Promise<void> {
    this.invalidateLocal();
  }

  async getOrIssue(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new ResumeApiError('cancelled');
    const current = this.usableCurrentToken();
    if (current !== null) return current;

    let stored: string | null;
    try {
      stored = await awaitAbortable(
        asPromise(() => SecureStore.getItemAsync(INSTALLATION_TOKEN_KEY)),
        signal,
      );
    } catch (error) {
      if (error instanceof AbortSignalFailure) throw new ResumeApiError('cancelled');
      throw new ResumeApiError('network');
    }
    if (signal.aborted) throw new ResumeApiError('cancelled');

    const newerCurrent = this.usableCurrentToken();
    if (newerCurrent !== null) return newerCurrent;
    const parsed = InstallationResponseSchema.safeParse({ schemaVersion: 1, installationToken: stored });
    if (parsed.success && !this.retiredTokens.has(parsed.data.installationToken) && !isExpiredToken(parsed.data.installationToken, this.now())) {
      this.currentToken = { generation: this.generation, token: parsed.data.installationToken };
      return parsed.data.installationToken;
    }

    const inFlight = this.inFlight ?? this.startIssue();
    return this.joinIssue(inFlight, signal);
  }

  private usableCurrentToken(): string | null {
    if (this.currentToken === null) return null;
    if (this.retiredTokens.has(this.currentToken.token) || isExpiredToken(this.currentToken.token, this.now())) {
      this.retireToken(this.currentToken.token);
      this.currentToken = null;
      return null;
    }
    return this.currentToken.token;
  }

  private startIssue(): InFlightIssue {
    const inFlight: InFlightIssue = {
      controller: new AbortController(),
      callers: new Set(),
      generation: ++this.generation,
      token: null,
      promise: Promise.resolve(''),
    };
    inFlight.promise = this.issue(inFlight).finally(() => {
      if (this.inFlight === inFlight) this.inFlight = null;
    });
    this.inFlight = inFlight;
    return inFlight;
  }

  private joinIssue(inFlight: InFlightIssue, signal: AbortSignal): Promise<string> {
    const caller = Symbol('installation-token-caller');
    inFlight.callers.add(caller);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const removeCaller = () => {
        signal.removeEventListener('abort', cancel);
        inFlight.callers.delete(caller);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        removeCaller();
        if (inFlight.callers.size === 0) this.abandon(inFlight);
        reject(new ResumeApiError('cancelled'));
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
      inFlight.promise.then(
        (token) => {
          if (settled) return;
          if (signal.aborted) {
            cancel();
            return;
          }
          settled = true;
          removeCaller();
          resolve(token);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          removeCaller();
          reject(error);
        },
      );
    });
  }

  private isCurrent(inFlight: InFlightIssue): boolean {
    return (
      this.inFlight === inFlight &&
      this.generation === inFlight.generation &&
      inFlight.callers.size > 0 &&
      !inFlight.controller.signal.aborted
    );
  }

  private abandon(inFlight: InFlightIssue): void {
    if (inFlight.token !== null) this.retireToken(inFlight.token);
    if (this.currentToken?.generation === inFlight.generation) this.currentToken = null;
    if (this.inFlight === inFlight) {
      this.inFlight = null;
      if (this.generation === inFlight.generation) this.generation += 1;
    }
    inFlight.controller.abort();
  }

  private invalidateLocal(): void {
    const inFlight = this.inFlight;
    if (inFlight !== null) this.abandon(inFlight);
    else this.generation += 1;
    if (this.currentToken !== null) this.retireToken(this.currentToken.token);
    this.currentToken = null;
  }

  private retireToken(token: string): void {
    this.retiredTokens.add(token);
    if (this.retiredTokens.size > 64) {
      const oldest = this.retiredTokens.values().next().value;
      if (typeof oldest === 'string') this.retiredTokens.delete(oldest);
    }
  }

  private async issue(inFlight: InFlightIssue): Promise<string> {
    let response: Response;
    try {
      response = await awaitAbortable(
        asPromise(() => this.fetchImpl(`${this.apiBaseUrl}/v1/installations`, {
          method: 'POST',
          signal: inFlight.controller.signal,
        })),
        inFlight.controller.signal,
      );
    } catch (error) {
      if (error instanceof AbortSignalFailure || inFlight.controller.signal.aborted) {
        throw new ResumeApiError('cancelled');
      }
      throw new ResumeApiError('network');
    }
    if (!this.isCurrent(inFlight)) throw new ResumeApiError('cancelled');

    let data: unknown;
    try {
      data = await awaitAbortable(asPromise(() => response.json()), inFlight.controller.signal);
    } catch (error) {
      if (error instanceof AbortSignalFailure || inFlight.controller.signal.aborted) {
        throw new ResumeApiError('cancelled');
      }
      throw new ResumeApiError('invalid_response');
    }
    if (!this.isCurrent(inFlight)) throw new ResumeApiError('cancelled');
    if (response.status !== 201) {
      const publicError = PublicErrorSchema.safeParse(data);
      if (!publicError.success) throw new ResumeApiError('invalid_response');
      throw new ResumeApiError('service', publicError.data);
    }
    const installation = InstallationResponseSchema.safeParse(data);
    if (!installation.success) throw new ResumeApiError('invalid_response');
    inFlight.token = installation.data.installationToken;
    if (!this.isCurrent(inFlight)) {
      this.retireToken(inFlight.token);
      throw new ResumeApiError('cancelled');
    }

    const write = asPromise(() => SecureStore.setItemAsync(INSTALLATION_TOKEN_KEY, inFlight.token!, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }));
    try {
      await awaitAbortable(write, inFlight.controller.signal);
    } catch (error) {
      if (error instanceof AbortSignalFailure || inFlight.controller.signal.aborted) {
        this.retireToken(inFlight.token);
        void write.then(
          () => this.retireToken(inFlight.token!),
          () => undefined,
        );
        throw new ResumeApiError('cancelled');
      }
      throw new ResumeApiError('network');
    }
    if (!this.isCurrent(inFlight)) {
      this.retireToken(inFlight.token);
      throw new ResumeApiError('cancelled');
    }
    this.currentToken = { generation: inFlight.generation, token: inFlight.token };
    return inFlight.token;
  }
}
