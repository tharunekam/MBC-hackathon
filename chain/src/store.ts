/**
 * Everything the chain service remembers, in one JSON file written atomically.
 * It holds the salts needed to reveal calls later, so it is kept out of git (`chain/data/`).
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CallFields } from './hash.ts';

export interface CallRow {
  id: string;
  betId: string;
  user: string;
  handle: string;
  /**
   * `pending`: the salt and fields are saved but the commit is not known to have landed. The record is written BEFORE the
   * transaction is sent, so a crash or a timeout can never lose a salt (a call without its salt can never be revealed).
   */
  state: 'pending' | 'committed' | 'revealed' | 'void';
  /** Set while a reveal may be in flight (sent, outcome unknown). The next attempt checks the chain before sending again. */
  revealing?: boolean;
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

/** The store file exists but cannot be trusted. Never swallowed: starting empty would silently lose every salt. */
export class StoreError extends Error {}

function isStoreData(v: unknown): v is StoreData {
  if (v === null || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  const obj = (x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x);
  return typeof d.handleSecret === 'string' && d.handleSecret.length > 0 && Array.isArray(d.calls) && obj(d.commits) && obj(d.reveals);
}

function readStore(path: string): StoreData | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isStoreData(v) ? v : null;
  } catch {
    return null;
  }
}

export class Store {
  readonly data: StoreData;
  private readonly path: string | null;

  /**
   * Pass `null` for an in-memory store (tests). With a path: loads it; if it is damaged, falls back to the previous good
   * copy (`.bak`) and says so loudly; if neither can be read it THROWS rather than start empty, because an empty store
   * would silently throw away every salt and change every handle.
   */
  constructor(path: string | null, newSecret: () => string, warn: (line: string) => void = (l) => console.error(l)) {
    this.path = path;
    const bak = path ? `${path}.bak` : null;
    if (path && existsSync(path)) {
      const main = readStore(path);
      if (main) this.data = main;
      else {
        const fallback = bak && existsSync(bak) ? readStore(bak) : null;
        if (!fallback) throw new StoreError(`${path} exists but is not a valid store, and there is no usable backup. Refusing to start empty: that would lose every salt. Restore it from a copy, or move it aside if you really want to begin again.`);
        warn(`[chain] ${path} was damaged; restored the previous copy (${bak}). Calls made since that copy was written may be missing.`);
        this.data = fallback;
      }
    } else if (bak && existsSync(bak)) {
      const fallback = readStore(bak);
      if (!fallback) throw new StoreError(`${path} is missing and ${bak} is not a valid store. Refusing to start empty.`);
      warn(`[chain] ${path} was missing; restored ${bak}.`);
      this.data = fallback;
    } else {
      this.data = { handleSecret: newSecret(), calls: [], commits: {}, reveals: {} };
    }
    this.save();
  }

  /** Durable: written to a temp file and fsynced, the previous good copy kept as .bak, then renamed into place. */
  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(this.data, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Keep the last good version, but only if it really is good: never replace a good backup with a bad file.
    if (existsSync(this.path) && readStore(this.path)) copyFileSync(this.path, `${this.path}.bak`);
    renameSync(tmp, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}
