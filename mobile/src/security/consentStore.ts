import SQLiteKeyValueStore from 'expo-sqlite/kv-store';

export { CONSENT_VERSION } from '../domain/consent';
import { CONSENT_VERSION } from '../domain/consent';
export const CONSENT_STORAGE_KEY = 'resume-ai.consent.v1';

export type ConsentKeyValueStore = Readonly<{
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<unknown>;
}>;

type ConsentRecord = Readonly<{ state: 'accepted'; version: string }>;

function isCurrentRecord(value: unknown, version: string): value is ConsentRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.state === 'accepted' &&
    record.version === version
  );
}

export class ConsentStore {
  constructor(
    private readonly storage: ConsentKeyValueStore = SQLiteKeyValueStore,
    private readonly version = CONSENT_VERSION,
  ) {}

  async grant(): Promise<void> {
    const record: ConsentRecord = { state: 'accepted', version: this.version };
    await this.storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
  }

  async hasCurrentConsent(): Promise<boolean> {
    const stored = await this.storage.getItem(CONSENT_STORAGE_KEY);
    if (typeof stored !== 'string') return false;
    try {
      return isCurrentRecord(JSON.parse(stored), this.version);
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(CONSENT_STORAGE_KEY);
  }
}
