/**
 * Everything the chain service remembers, in one JSON file written atomically.
 * It holds the salts needed to reveal calls later, so it is kept out of git (`chain/data/`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CallFields } from './hash.ts';

export interface CallRow {
  id: string;
  betId: string;
  user: string;
  handle: string;
  state: 'committed' | 'revealed' | 'void';
  salt: string;
  fields: CallFields;
  hash: string;
  commitSignature: string;
  commitSlot: number;
  committedAt: string;
  network: 'devnet' | 'fake';
  /** Kept for the owner's own view; they are not on chain. */
  eventTitle: string;
  conditionLabel: string;
  targetLabel: string;
  reveal?: { signature: string; slot: number; revealedAt: string; outcome: 0 | 1; edge: number };
}

/** A commit seen on chain (by our own write or by the Stream). */
export interface SeenCommit {
  signature: string;
  hash: string;
  handle: string;
  at: number;
}

/** A reveal seen on chain, with the result of checking it against its commit. */
export interface SeenReveal {
  signature: string;
  commitSignature: string;
  handle: string;
  betId: string;
  event: string;
  condition: string;
  target: string;
  entryPrice: number;
  fairPrice: number;
  outcome: 0 | 1;
  edge: number;
  /** Unix seconds of the reveal transaction, else when we first saw it. */
  revealedAt: number;
  via: 'stream' | 'rpc' | 'local';
  verified: boolean;
  reason?: string;
}

export interface StoreData {
  handleSecret: string;
  calls: CallRow[];
  commits: Record<string, SeenCommit>;
  reveals: Record<string, SeenReveal>;
}

export class Store {
  readonly data: StoreData;
  private readonly path: string | null;

  /** Pass `null` for an in-memory store (tests). */
  constructor(path: string | null, newSecret: () => string) {
    this.path = path;
    if (path && existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, 'utf8')) as StoreData;
    } else {
      this.data = { handleSecret: newSecret(), calls: [], commits: {}, reveals: {} };
      this.save();
    }
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
