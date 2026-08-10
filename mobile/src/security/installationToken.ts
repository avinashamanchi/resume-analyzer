import * as SecureStore from 'expo-secure-store';

import { validateApiBaseUrl } from '../api/apiBaseUrl';
import {
  InstallationResponseSchema,
  InstallationResponseV2Schema,
  PublicErrorSchema,
} from '../domain/contracts';
import { ResumeApiError } from '../domain/errors';
import {
  SQLiteTokenAuthorityStore,
  assertTokenAuthorityState,
  type TokenAuthorityState,
  type TokenAuthorityStore,
} from './tokenAuthority';

// A namespace, not a token-bearing SQLite key. Every SecureStore value under
// it is a signed anonymous token, isolated by its durable generation.
export const INSTALLATION_TOKEN_KEY = 'resume-ai.installation-token.v1';
export const INSTALLATION_REVENUECAT_KEY = 'resume-ai.installation-revenuecat.v1';

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export type InstallationTokenStoreOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl?: FetchImplementation;
  now?: () => number;
  authorityStore?: TokenAuthorityStore;
}>;

export type InstallationTokenAcquisitionObserver = Readonly<{
  // Fired synchronously after the store enters its non-abortable finalize
  // phase and before the authority transition starts.
  onCommit(): void;
}>;

type IssuePhase = 'issuing' | 'committing' | 'cancelling';

type InFlightIssue = {
  readonly controller: AbortController;
  readonly callers: Set<symbol>;
  readonly observers: Set<InstallationTokenAcquisitionObserver>;
  generation: number | null;
  phase: IssuePhase;
  retirement: Promise<void> | null;
  promise: Promise<string>;
};

const MAX_ACTIVE_READ_ATTEMPTS = 3;

type ActiveToken = Readonly<{ generation: number; token: string }>;

export type InstallationIdentity = Readonly<{
  installationToken: string;
  revenueCatAppUserId: string;
}>;

class AbortSignalFailure extends Error {}

export function installationTokenSlot(generation: number): string {
  return `${INSTALLATION_TOKEN_KEY}.g${generation}`;
}

export function installationRevenueCatSlot(generation: number): string {
  return `${INSTALLATION_REVENUECAT_KEY}.g${generation}`;
}

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

function asPromise<T>(operation: () => Promise<T> | T): Promise<T> {
  return Promise.resolve().then(operation);
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

export class InstallationTokenStore {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly now: () => number;
  private readonly authorityStore: TokenAuthorityStore;
  private currentToken: ActiveToken | null = null;
  private inFlight: InFlightIssue | null = null;

  constructor(options: InstallationTokenStoreOptions) {
    this.apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.authorityStore = options.authorityStore ?? new SQLiteTokenAuthorityStore();
  }

  async save(token: string, signal?: AbortSignal): Promise<void> {
    const parsed = InstallationResponseSchema.safeParse({ schemaVersion: 1, installationToken: token });
    if (!parsed.success) throw new ResumeApiError('validation');

    let generation: number | null = null;
    let finalized = false;
    try {
      generation = await this.awaitAuthority(() => this.authorityStore.reserve(), signal);
      await this.writeToken(generation, parsed.data.installationToken, signal);
      if (signal?.aborted) throw new AbortSignalFailure();
      // Finalize is the durable commit point. It must run to a known outcome;
      // aborting only the await would let SQLite activate a token after a caller
      // was told that it had been cancelled.
      const result = await this.awaitAuthority(() => this.authorityStore.finalize(generation!));
      if (!result.activated) throw new ResumeApiError('cancelled');
      finalized = true;
      const confirmed = await this.readAuthority();
      if (confirmed.activeGeneration !== generation) throw new ResumeApiError('network');
      this.currentToken = { generation, token: parsed.data.installationToken };
    } catch (error) {
      if (generation !== null && !finalized) {
        try {
          await this.retireGeneration(generation);
        } catch (retireError) {
          throw this.storageError(retireError);
        }
      }
      throw this.storageError(error);
    }
  }

  async clear(signal?: AbortSignal): Promise<void> {
    let generations: number[];
    try {
      generations = await this.awaitAuthority(() => this.authorityStore.retireAll(), signal);
      this.currentToken = null;
    } catch (error) {
      throw this.storageError(error);
    }
    await Promise.all(generations.map((generation) => this.deleteGeneration(generation, signal)));
  }

  async invalidate(expectedToken: string): Promise<void> {
    if (typeof expectedToken !== 'string' || expectedToken.length === 0) return;
    let state: TokenAuthorityState;
    try {
      state = await this.readAuthority();
    } catch {
      return;
    }
    if (state.activeGeneration === null) return;
    const generation = state.activeGeneration;
    let activeToken: string | null;
    if (this.currentToken?.generation === generation) {
      activeToken = this.currentToken.token;
    } else {
      try {
        activeToken = await asPromise(() => SecureStore.getItemAsync(installationTokenSlot(generation)));
      } catch {
        return;
      }
    }
    if (activeToken !== expectedToken) return;
    try {
      const retired = await asPromise(() => this.authorityStore.retire(generation));
      if (retired && this.currentToken?.generation === generation) this.currentToken = null;
    } catch {
      // A later submit will still ask the server to validate its installation token.
    }
  }

  async getOrIssue(signal: AbortSignal, observer?: InstallationTokenAcquisitionObserver): Promise<string> {
    if (signal.aborted) throw new ResumeApiError('cancelled');
    const active = await this.readActive(signal);
    if (active !== null) return active;
    const inFlight = this.inFlight ?? this.startIssue();
    return this.joinIssue(inFlight, signal, observer);
  }

  async getOrIssueIdentity(signal: AbortSignal): Promise<InstallationIdentity> {
    if (signal.aborted) throw new ResumeApiError('cancelled');
    for (let attempt = 0; attempt < MAX_ACTIVE_READ_ATTEMPTS; attempt += 1) {
      const installationToken = await this.getOrIssue(signal);
      let state: TokenAuthorityState;
      try {
        state = await this.readAuthority(signal);
      } catch (error) {
        throw this.storageError(error);
      }
      const generation = state.activeGeneration;
      if (generation === null) continue;

      let storedToken: string | null;
      let revenueCatAppUserId: string | null;
      try {
        [storedToken, revenueCatAppUserId] = await Promise.all([
          awaitAbortable(
            asPromise(() => SecureStore.getItemAsync(installationTokenSlot(generation))),
            signal,
          ),
          awaitAbortable(
            asPromise(() => SecureStore.getItemAsync(installationRevenueCatSlot(generation))),
            signal,
          ),
        ]);
      } catch (error) {
        throw this.storageError(error);
      }
      const confirmed = await this.readAuthority(signal);
      if (confirmed.activeGeneration !== generation) continue;

      const parsed = InstallationResponseV2Schema.safeParse({
        schemaVersion: 2,
        installationToken: storedToken,
        revenueCatAppUserId,
      });
      if (
        parsed.success &&
        parsed.data.installationToken === installationToken &&
        !isExpiredToken(parsed.data.installationToken, this.now())
      ) {
        this.currentToken = { generation, token: parsed.data.installationToken };
        return Object.freeze({
          installationToken: parsed.data.installationToken,
          revenueCatAppUserId: parsed.data.revenueCatAppUserId,
        });
      }

      try {
        const retired = await this.awaitAuthority(() => this.authorityStore.retire(generation), signal);
        if (retired && this.currentToken?.generation === generation) this.currentToken = null;
        if (retired) await this.deleteGeneration(generation, signal);
      } catch (error) {
        throw this.storageError(error);
      }
    }
    throw new ResumeApiError('network');
  }

  private async readActive(signal?: AbortSignal): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_ACTIVE_READ_ATTEMPTS; attempt += 1) {
      let state: TokenAuthorityState;
      try {
        state = await this.readAuthority(signal);
      } catch (error) {
        throw this.storageError(error);
      }
      const generation = state.activeGeneration;
      if (generation === null) return null;

      let token: string | null;
      if (this.currentToken?.generation === generation) {
        token = this.currentToken.token;
      } else {
        try {
          token = await awaitAbortable(
            asPromise(() => SecureStore.getItemAsync(installationTokenSlot(generation))),
            signal,
          );
        } catch (error) {
          throw this.storageError(error);
        }
      }

      let confirmed: TokenAuthorityState;
      try {
        confirmed = await this.readAuthority(signal);
      } catch (error) {
        throw this.storageError(error);
      }
      if (confirmed.activeGeneration !== generation) {
        if (this.currentToken?.generation === generation) this.currentToken = null;
        continue;
      }

      const parsed = InstallationResponseSchema.safeParse({ schemaVersion: 1, installationToken: token });
      if (parsed.success && !isExpiredToken(parsed.data.installationToken, this.now())) {
        this.currentToken = { generation, token: parsed.data.installationToken };
        return parsed.data.installationToken;
      }
      try {
        const retired = await this.awaitAuthority(() => this.authorityStore.retire(generation), signal);
        if (!retired) {
          if (this.currentToken?.generation === generation) this.currentToken = null;
          continue;
        }
      } catch (error) {
        throw this.storageError(error);
      }
      if (this.currentToken?.generation === generation) this.currentToken = null;
      return null;
    }
    throw new ResumeApiError('network');
  }

  private startIssue(): InFlightIssue {
    const inFlight: InFlightIssue = {
      controller: new AbortController(),
      callers: new Set(),
      observers: new Set(),
      generation: null,
      phase: 'issuing',
      retirement: null,
      promise: Promise.resolve(''),
    };
    inFlight.promise = this.issue(inFlight).finally(() => {
      if (this.inFlight === inFlight) this.inFlight = null;
    });
    // All callers may cancel before a non-abortable native operation settles.
    // Keep that detached rejection observed while each caller still receives its
    // own cancellation result from joinIssue.
    void inFlight.promise.catch(() => undefined);
    this.inFlight = inFlight;
    return inFlight;
  }

  private joinIssue(
    inFlight: InFlightIssue,
    signal: AbortSignal,
    observer?: InstallationTokenAcquisitionObserver,
  ): Promise<string> {
    const caller = Symbol('installation-token-caller');
    inFlight.callers.add(caller);
    if (observer !== undefined) {
      // A late caller needs the same bounded-wait signal, but a committed
      // reconciliation must not retain that observer after it has fired.
      if (inFlight.phase === 'committing') this.notifyCommit(observer);
      else inFlight.observers.add(observer);
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let cancelling = false;
      const removeCaller = () => {
        signal.removeEventListener('abort', cancel);
        inFlight.callers.delete(caller);
        if (observer !== undefined) inFlight.observers.delete(observer);
      };
      const cancel = () => {
        if (settled || cancelling) return;
        // Finalize is deliberately non-abortable after this synchronous
        // transition. Detach this caller immediately instead of retaining its
        // signal, observer, and join promise until reconciliation settles.
        // Its own outcome is indeterminate because durable authority may
        // still activate the anonymous token.
        if (inFlight.phase === 'committing') {
          settled = true;
          removeCaller();
          reject(new ResumeApiError('indeterminate', { retryable: true }));
          return;
        }
        cancelling = true;
        removeCaller();
        if (inFlight.callers.size > 0) {
          settled = true;
          reject(new ResumeApiError('cancelled'));
          return;
        }
        void this.cancelBeforeCommit(inFlight).then(
          () => {
            if (settled) return;
            settled = true;
            reject(new ResumeApiError('cancelled'));
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(this.storageError(error));
          },
        );
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
      inFlight.promise.then(
        (token) => {
          if (settled || cancelling) return;
          if (signal.aborted && inFlight.phase !== 'committing') {
            cancel();
            return;
          }
          settled = true;
          removeCaller();
          resolve(token);
        },
        (error: unknown) => {
          if (settled || cancelling) return;
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
      inFlight.phase === 'issuing' &&
      inFlight.callers.size > 0 &&
      !inFlight.controller.signal.aborted
    );
  }

  private notifyCommit(observer: InstallationTokenAcquisitionObserver): void {
    try {
      observer.onCommit();
    } catch {
      // Observers only let callers bound their own wait; they never control
      // the durable authority transition.
    }
  }

  private notifyCommitObservers(inFlight: InFlightIssue): void {
    // Observer callbacks only carry each caller's local wait state. Clear
    // their references before invoking them so a hung authority operation
    // retains no caller-owned closure or request payload through this store.
    const observers = [...inFlight.observers];
    inFlight.observers.clear();
    for (const observer of observers) this.notifyCommit(observer);
  }

  private async cancelBeforeCommit(inFlight: InFlightIssue): Promise<void> {
    if (inFlight.phase === 'committing') return;
    inFlight.phase = 'cancelling';
    if (this.inFlight === inFlight) this.inFlight = null;
    inFlight.controller.abort();
    if (inFlight.generation !== null) await this.retireInFlightGeneration(inFlight);
  }

  private async retireGeneration(generation: number): Promise<void> {
    await asPromise(() => this.authorityStore.retire(generation));
  }

  private retireInFlightGeneration(inFlight: InFlightIssue): Promise<void> {
    if (inFlight.generation === null) return Promise.resolve();
    if (inFlight.retirement === null) {
      inFlight.retirement = this.retireGeneration(inFlight.generation);
    }
    return inFlight.retirement;
  }

  private async issue(inFlight: InFlightIssue): Promise<string> {
    let finalized = false;
    try {
      inFlight.generation = await this.awaitAuthority(
        () => this.authorityStore.reserve(),
        inFlight.controller.signal,
      );
      if (!this.isCurrent(inFlight)) throw new ResumeApiError('cancelled');

      let response: Response;
      try {
        response = await awaitAbortable(
          asPromise(() => this.fetchImpl(`${this.apiBaseUrl}/v2/installations`, {
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
      const installation = InstallationResponseV2Schema.safeParse(data);
      if (!installation.success) throw new ResumeApiError('invalid_response');

      await this.writeToken(inFlight.generation, installation.data.installationToken, inFlight.controller.signal);
      await this.writeRevenueCatIdentity(
        inFlight.generation,
        installation.data.revenueCatAppUserId,
        inFlight.controller.signal,
      );
      if (!this.isCurrent(inFlight)) throw new ResumeApiError('cancelled');
      // This assignment and the following finalize call are the explicit commit
      // phase. From here, cancellation waits for a known durable outcome and a
      // successful finalize wins over the caller's late abort.
      inFlight.phase = 'committing';
      this.notifyCommitObservers(inFlight);
      const result = await this.awaitAuthority(() => this.authorityStore.finalize(inFlight.generation!));
      if (!result.activated) throw new ResumeApiError('cancelled');
      finalized = true;
      const confirmed = await this.readAuthority();
      if (confirmed.activeGeneration !== inFlight.generation) {
        const replacement = await this.readActive();
        if (replacement !== null) return replacement;
        throw new ResumeApiError('network');
      }
      this.currentToken = { generation: inFlight.generation, token: installation.data.installationToken };
      return installation.data.installationToken;
    } catch (error) {
      if (inFlight.generation !== null && !finalized) {
        try {
          await this.retireInFlightGeneration(inFlight);
        } catch (retireError) {
          throw this.storageError(retireError);
        }
      }
      throw this.storageError(error);
    }
  }

  private async writeToken(generation: number, token: string, signal?: AbortSignal): Promise<void> {
    try {
      await awaitAbortable(
        asPromise(() => SecureStore.setItemAsync(installationTokenSlot(generation), token, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        })),
        signal,
      );
    } catch (error) {
      throw this.storageError(error);
    }
  }

  private async writeRevenueCatIdentity(
    generation: number,
    revenueCatAppUserId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await awaitAbortable(
        asPromise(() => SecureStore.setItemAsync(
          installationRevenueCatSlot(generation),
          revenueCatAppUserId,
          { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
        )),
        signal,
      );
    } catch (error) {
      throw this.storageError(error);
    }
  }

  private async deleteToken(generation: number, signal?: AbortSignal): Promise<void> {
    try {
      await awaitAbortable(
        asPromise(() => SecureStore.deleteItemAsync(installationTokenSlot(generation))),
        signal,
      );
    } catch (error) {
      throw this.storageError(error);
    }
  }

  private async deleteGeneration(generation: number, signal?: AbortSignal): Promise<void> {
    await Promise.all([
      this.deleteToken(generation, signal),
      this.deleteRevenueCatIdentity(generation, signal),
    ]);
  }

  private async deleteRevenueCatIdentity(generation: number, signal?: AbortSignal): Promise<void> {
    try {
      await awaitAbortable(
        asPromise(() => SecureStore.deleteItemAsync(installationRevenueCatSlot(generation))),
        signal,
      );
    } catch (error) {
      throw this.storageError(error);
    }
  }

  private async awaitAuthority<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return awaitAbortable(asPromise(operation), signal);
  }

  private async readAuthority(signal?: AbortSignal): Promise<TokenAuthorityState> {
    return assertTokenAuthorityState(await this.awaitAuthority(() => this.authorityStore.read(), signal));
  }

  private storageError(error: unknown): ResumeApiError {
    if (error instanceof ResumeApiError) return error;
    if (error instanceof AbortSignalFailure) return new ResumeApiError('cancelled');
    return new ResumeApiError('network');
  }
}
