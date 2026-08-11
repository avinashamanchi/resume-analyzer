import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

export type TokenAuthorityState = Readonly<{
  nextGeneration: number;
  activeGeneration: number | null;
  pendingGeneration: number | null;
}>;

export type TokenAuthorityFinalizeResult = Readonly<{
  activated: boolean;
  replacedGeneration: number | null;
}>;

// This metadata intentionally contains generations only: signed tokens stay in
// device-only SecureStore generation slots and never enter SQLite.
export type TokenAuthorityStore = Readonly<{
  read(): Promise<TokenAuthorityState>;
  reserve(): Promise<number>;
  finalize(generation: number): Promise<TokenAuthorityFinalizeResult>;
  retire(generation: number): Promise<boolean>;
  retireAll(): Promise<number[]>;
}>;

type AuthorityRow = Readonly<{
  next_generation: number;
  active_generation: number | null;
  pending_generation: number | null;
}>;

type AuthorityDatabase = Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>;

const AUTHORITY_DATABASE = 'resume-ai-token-authority.db';
const AUTHORITY_TABLE = 'installation_token_authority';

function assertGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('Token authority contains an invalid generation.');
  }
  return value as number;
}

function assertOptionalGeneration(value: unknown): number | null {
  return value === null ? null : assertGeneration(value);
}

// Treat authority metadata as untrusted persistent input. In particular, a
// generation must always be positive and nextGeneration must remain ahead of
// every generation that can still name a SecureStore slot.
export function assertTokenAuthorityState(value: unknown): TokenAuthorityState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Token authority state is malformed.');
  }
  const state = value as Record<string, unknown>;
  const nextGeneration = assertGeneration(state.nextGeneration);
  const activeGeneration = assertOptionalGeneration(state.activeGeneration);
  const pendingGeneration = assertOptionalGeneration(state.pendingGeneration);
  if (
    (activeGeneration === pendingGeneration && activeGeneration !== null) ||
    (activeGeneration !== null && nextGeneration <= activeGeneration) ||
    (pendingGeneration !== null && nextGeneration <= pendingGeneration)
  ) {
    throw new Error('Token authority generations violate ordering invariants.');
  }
  return { nextGeneration, activeGeneration, pendingGeneration };
}

function stateFromRow(row: AuthorityRow): TokenAuthorityState {
  return assertTokenAuthorityState({
    nextGeneration: row.next_generation,
    activeGeneration: row.active_generation,
    pendingGeneration: row.pending_generation,
  });
}

export class SQLiteTokenAuthorityStore implements TokenAuthorityStore {
  private databasePromise: Promise<SQLiteDatabase> | null = null;

  async read(): Promise<TokenAuthorityState> {
    const database = await this.database();
    const row = await database.getFirstAsync<AuthorityRow>(
      `SELECT next_generation, active_generation, pending_generation FROM ${AUTHORITY_TABLE} WHERE id = 1`,
    );
    if (row === null) throw new Error('Token authority row is missing.');
    return stateFromRow(row);
  }

  async reserve(): Promise<number> {
    return this.exclusive(async (database, state) => {
      const generation = state.nextGeneration;
      if (generation === Number.MAX_SAFE_INTEGER) {
        throw new Error('Token authority generation space is exhausted.');
      }
      await database.runAsync(
        `UPDATE ${AUTHORITY_TABLE} SET next_generation = ?, pending_generation = ? WHERE id = 1`,
        generation + 1,
        generation,
      );
      return generation;
    });
  }

  async finalize(generation: number): Promise<TokenAuthorityFinalizeResult> {
    assertGeneration(generation);
    return this.exclusive(async (database, state) => {
      if (state.pendingGeneration !== generation) {
        return { activated: false, replacedGeneration: state.activeGeneration };
      }
      await database.runAsync(
        `UPDATE ${AUTHORITY_TABLE} SET active_generation = ?, pending_generation = NULL WHERE id = 1`,
        generation,
      );
      return { activated: true, replacedGeneration: state.activeGeneration };
    });
  }

  async retire(generation: number): Promise<boolean> {
    assertGeneration(generation);
    return this.exclusive(async (database, state) => {
      const matches = state.activeGeneration === generation || state.pendingGeneration === generation;
      if (!matches) return false;
      await database.runAsync(
        `UPDATE ${AUTHORITY_TABLE}
         SET active_generation = CASE WHEN active_generation = ? THEN NULL ELSE active_generation END,
             pending_generation = CASE WHEN pending_generation = ? THEN NULL ELSE pending_generation END
         WHERE id = 1`,
        generation,
        generation,
      );
      return true;
    });
  }

  async retireAll(): Promise<number[]> {
    return this.exclusive(async (database, state) => {
      const generations = [state.activeGeneration, state.pendingGeneration].filter(
        (generation): generation is number => generation !== null,
      );
      await database.runAsync(
        `UPDATE ${AUTHORITY_TABLE} SET active_generation = NULL, pending_generation = NULL WHERE id = 1`,
      );
      return generations;
    });
  }

  private async database(): Promise<SQLiteDatabase> {
    if (this.databasePromise === null) {
      this.databasePromise = (async () => {
        const database = await openDatabaseAsync(AUTHORITY_DATABASE);
        await database.execAsync(
          `CREATE TABLE IF NOT EXISTS ${AUTHORITY_TABLE} (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             next_generation INTEGER NOT NULL,
             active_generation INTEGER,
             pending_generation INTEGER
           );
           INSERT OR IGNORE INTO ${AUTHORITY_TABLE} (id, next_generation, active_generation, pending_generation)
           VALUES (1, 1, NULL, NULL);`,
        );
        return database;
      })();
    }
    return this.databasePromise;
  }

  private async exclusive<T>(operation: (database: AuthorityDatabase, state: TokenAuthorityState) => Promise<T>): Promise<T> {
    const database = await this.database();
    let result: T | undefined;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<AuthorityRow>(
        `SELECT next_generation, active_generation, pending_generation FROM ${AUTHORITY_TABLE} WHERE id = 1`,
      );
      if (row === null) throw new Error('Token authority row is missing.');
      result = await operation(transaction, stateFromRow(row));
    });
    if (result === undefined) throw new Error('Token authority transaction did not complete.');
    return result;
  }
}
