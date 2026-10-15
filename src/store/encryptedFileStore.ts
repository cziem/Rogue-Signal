import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { open, seal, type SealedBox } from '../crypto.js';
import { emptyState, purgeExpired, type PersistedState } from './state.js';

const FILE_AAD = 'rogue-signal-state:v1';

export interface StateStore {
  /** Runs `fn` against the current state; if it returns without throwing, the state is persisted. */
  update<T>(fn: (state: PersistedState) => T | Promise<T>): Promise<T>;
  /** Read-only access. Mutations made inside `fn` are NOT persisted. */
  read<T>(fn: (state: Readonly<PersistedState>) => T): Promise<T>;
}

/**
 * Whole-file AES-256-GCM encrypted JSON store.
 *
 * Designed for a single-instance deployment (one Cloud Run instance / one Fly machine)
 * with a persistent volume. Writes are serialized through a promise queue and made
 * atomic with write-to-temp + rename. Secrets inside (Google refresh tokens) are
 * additionally sealed individually; bearer tokens are stored only as hashes.
 */
export class EncryptedFileStore implements StateStore {
  private state: PersistedState | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly key: Buffer,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.path = join(dataDir, 'state.enc');
  }

  update<T>(fn: (state: PersistedState) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const state = await this.load();
      // Work on a copy so a throwing mutation leaves the committed state untouched.
      const draft = structuredClone(state);
      purgeExpired(draft, this.now());
      const result = await fn(draft);
      await this.persist(draft);
      this.state = draft;
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async read<T>(fn: (state: Readonly<PersistedState>) => T): Promise<T> {
    await this.queue;
    const state = await this.load();
    return fn(structuredClone(state));
  }

  private async load(): Promise<PersistedState> {
    if (this.state) return this.state;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState();
        return this.state;
      }
      throw error;
    }
    let box: SealedBox;
    try {
      box = JSON.parse(raw) as SealedBox;
      this.state = JSON.parse(open(box, this.key, FILE_AAD)) as PersistedState;
    } catch {
      throw new Error(
        `Could not decrypt ${this.path}. Was TOKEN_ENCRYPTION_KEY changed? ` +
          'Restore the old key, or delete the file to start over (all connections must re-authorize).',
      );
    }
    return this.state;
  }

  private async persist(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const box = seal(JSON.stringify(state), this.key, FILE_AAD);
    await writeFile(tmp, JSON.stringify(box), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

/** Non-persistent store for tests. */
export class MemoryStore implements StateStore {
  private state: PersistedState = emptyState();
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async update<T>(fn: (state: PersistedState) => T | Promise<T>): Promise<T> {
    const draft = structuredClone(this.state);
    purgeExpired(draft, this.now());
    const result = await fn(draft);
    this.state = draft;
    return result;
  }

  read<T>(fn: (state: Readonly<PersistedState>) => T): Promise<T> {
    return Promise.resolve(fn(structuredClone(this.state)));
  }
}
