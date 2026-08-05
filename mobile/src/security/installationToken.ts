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
  promise: Promise<string>;
};

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

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ResumeApiError('invalid_response');
  }
}

export class InstallationTokenStore {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly now: () => number;
  private inFlight: InFlightIssue | null = null;

  constructor(options: InstallationTokenStoreOptions) {
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async save(token: string): Promise<void> {
    const parsed = InstallationResponseSchema.safeParse({ schemaVersion: 1, installationToken: token });
    if (!parsed.success) throw new ResumeApiError('validation');
    await SecureStore.setItemAsync(INSTALLATION_TOKEN_KEY, parsed.data.installationToken, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(INSTALLATION_TOKEN_KEY);
  }

  async invalidate(): Promise<void> {
    await this.clear();
  }

  async getOrIssue(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new ResumeApiError('cancelled');
    const stored = await SecureStore.getItemAsync(INSTALLATION_TOKEN_KEY);
    if (signal.aborted) throw new ResumeApiError('cancelled');
    if (typeof stored === 'string' && stored.length > 0 && !isExpiredToken(stored, this.now())) {
      return stored;
    }
    if (typeof stored === 'string' && isExpiredToken(stored, this.now())) await this.clear();
    if (signal.aborted) throw new ResumeApiError('cancelled');

    const inFlight = this.inFlight ?? this.startIssue();
    return this.joinIssue(inFlight, signal);
  }

  private startIssue(): InFlightIssue {
    const inFlight: InFlightIssue = {
      controller: new AbortController(),
      callers: new Set(),
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
      const release = (): boolean => {
        signal.removeEventListener('abort', cancel);
        inFlight.callers.delete(caller);
        const noCallersRemain = inFlight.callers.size === 0;
        if (noCallersRemain) inFlight.controller.abort();
        return noCallersRemain;
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        const noCallersRemain = release();
        if (noCallersRemain) void this.clear();
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
          release();
          resolve(token);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          release();
          reject(error);
        },
      );
    });
  }

  private async issue(inFlight: InFlightIssue): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/v1/installations`, {
        method: 'POST',
        signal: inFlight.controller.signal,
      });
    } catch {
      if (inFlight.controller.signal.aborted) throw new ResumeApiError('cancelled');
      throw new ResumeApiError('network');
    }
    if (inFlight.controller.signal.aborted || inFlight.callers.size === 0) {
      throw new ResumeApiError('cancelled');
    }
    const data = await parseJson(response);
    if (inFlight.controller.signal.aborted || inFlight.callers.size === 0) {
      throw new ResumeApiError('cancelled');
    }
    if (response.status !== 201) {
      const publicError = PublicErrorSchema.safeParse(data);
      if (!publicError.success) throw new ResumeApiError('invalid_response');
      throw new ResumeApiError('service', publicError.data);
    }
    const installation = InstallationResponseSchema.safeParse(data);
    if (!installation.success) throw new ResumeApiError('invalid_response');
    await this.save(installation.data.installationToken);
    if (inFlight.controller.signal.aborted || inFlight.callers.size === 0) {
      await this.clear();
      throw new ResumeApiError('cancelled');
    }
    return installation.data.installationToken;
  }
}
