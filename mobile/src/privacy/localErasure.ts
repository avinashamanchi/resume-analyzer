import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

export const LOCAL_ERASURE_JOURNAL_KEY = 'resume_ai.local_erasure.v1';

const MAX_JOURNAL_BYTES = 256;

const LocalErasureJournalSchema = z.object({
  schemaVersion: z.literal(1),
  sessionCleared: z.boolean(),
  reportsCleared: z.boolean(),
  workspaceCleared: z.boolean(),
}).strict();

type LocalErasureJournal = Readonly<z.infer<typeof LocalErasureJournalSchema>>;

const EMPTY_JOURNAL: LocalErasureJournal = Object.freeze({
  schemaVersion: 1,
  sessionCleared: false,
  reportsCleared: false,
  workspaceCleared: false,
});

export type LocalErasureReceipt = Readonly<{ completed: true }>;

export interface LocalErasureJournalPort {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

export type LocalErasureDependencies = Readonly<{
  journal: LocalErasureJournalPort;
  resetSession(): Promise<void>;
  deleteReports(): Promise<void>;
  deleteWorkspace(): Promise<void>;
}>;

export class LocalErasureError extends Error {
  readonly category = 'local_erasure' as const;

  constructor() {
    super('All local data could not be verified as deleted.');
    this.name = 'LocalErasureError';
  }
}

function encoded(value: LocalErasureJournal): string {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_JOURNAL_BYTES) throw new LocalErasureError();
  return serialized;
}

function decoded(value: string): LocalErasureJournal {
  if (value.length > MAX_JOURNAL_BYTES) throw new LocalErasureError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new LocalErasureError();
  }
  const journal = LocalErasureJournalSchema.safeParse(parsed);
  if (!journal.success) throw new LocalErasureError();
  return Object.freeze(journal.data);
}

function advanced(
  current: LocalErasureJournal,
  field: 'sessionCleared' | 'reportsCleared' | 'workspaceCleared',
): LocalErasureJournal {
  return Object.freeze({ ...current, [field]: true });
}

export class LocalErasureCoordinator {
  private flight: Promise<LocalErasureReceipt | null> | null = null;

  constructor(private readonly dependencies: LocalErasureDependencies) {}

  eraseAll(): Promise<LocalErasureReceipt> {
    return this.run(true) as Promise<LocalErasureReceipt>;
  }

  resume(): Promise<LocalErasureReceipt | null> {
    return this.run(false);
  }

  private run(createWhenAbsent: boolean): Promise<LocalErasureReceipt | null> {
    if (this.flight !== null) return this.flight;
    const flight = this.execute(createWhenAbsent).catch(() => {
      throw new LocalErasureError();
    });
    this.flight = flight;
    void flight.then(
      () => { if (this.flight === flight) this.flight = null; },
      () => { if (this.flight === flight) this.flight = null; },
    );
    return flight;
  }

  private async execute(createWhenAbsent: boolean): Promise<LocalErasureReceipt | null> {
    const persisted = await this.dependencies.journal.read();
    if (persisted === null && !createWhenAbsent) return null;

    let journal = persisted === null ? EMPTY_JOURNAL : decoded(persisted);
    if (persisted === null) await this.dependencies.journal.write(encoded(journal));

    if (!journal.sessionCleared) {
      await this.dependencies.resetSession();
      journal = advanced(journal, 'sessionCleared');
      await this.dependencies.journal.write(encoded(journal));
    }
    if (!journal.reportsCleared) {
      await this.dependencies.deleteReports();
      journal = advanced(journal, 'reportsCleared');
      await this.dependencies.journal.write(encoded(journal));
    }
    if (!journal.workspaceCleared) {
      await this.dependencies.deleteWorkspace();
      journal = advanced(journal, 'workspaceCleared');
      await this.dependencies.journal.write(encoded(journal));
    }

    await this.dependencies.journal.clear();
    return Object.freeze({ completed: true });
  }
}

export function createSecureLocalErasureJournal(): LocalErasureJournalPort {
  return Object.freeze({
    read: () => SecureStore.getItemAsync(LOCAL_ERASURE_JOURNAL_KEY),
    write: (value: string) => SecureStore.setItemAsync(LOCAL_ERASURE_JOURNAL_KEY, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
    clear: () => SecureStore.deleteItemAsync(LOCAL_ERASURE_JOURNAL_KEY),
  });
}
