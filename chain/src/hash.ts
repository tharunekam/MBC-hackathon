/**
 * The integrity core of commit-reveal.
 *
 * At bet time a call is reduced to a hash and only the hash goes on chain. After
 * the result, the plaintext fields and the salt are published. Anyone can then
 * recompute the hash from the revealed fields and check it equals the one that was
 * committed before the result was known. Nothing here talks to a network.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface CallFields {
  /** The executor's bet id. */
  betId: string;
  /** Gemini event ticker, e.g. BTC2611190100. */
  event: string;
  /** Condition contract symbol (the "given"). */
  condition: string;
  /** Target contract symbol (the second half). */
  target: string;
  /** Price paid per $1 when the bet was placed. */
  entryPrice: number;
  /** Fair price per $1 at entry: the market's own odds, no spread or fees. */
  fairPrice: number;
  /** Unix seconds at which the call was committed. */
  at: number;
}

export const PREIMAGE_VERSION = 'given1';

const fixed = (x: number): string => {
  if (!Number.isFinite(x)) throw new Error('A call field is not a number.');
  return x.toFixed(6);
};

/** The exact string that is hashed. Field order and number formatting are fixed so a call always hashes the same. */
export function preimage(f: CallFields, salt: string): string {
  for (const text of [f.betId, f.event, f.condition, f.target, salt]) {
    if (text.includes('|') || text === '') throw new Error('A call field is empty or contains "|".');
  }
  return [PREIMAGE_VERSION, f.betId, f.event, f.condition, f.target, fixed(f.entryPrice), fixed(f.fairPrice), String(f.at), salt].join('|');
}

export const commitHash = (f: CallFields, salt: string): string => createHash('sha256').update(preimage(f, salt)).digest('hex');

/** 128 random bits. Without it a short list of possible calls could be hashed and matched against the chain. */
export const newSalt = (): string => randomBytes(16).toString('hex');

/** What a call scores: 1 if the target hit, 0 if the condition held and the target missed, minus the fair price. */
export const edge = (outcome: 0 | 1, fairPrice: number): number => Math.round((outcome - fairPrice) * 10_000) / 10_000;

const ADJECTIVES = ['quiet', 'amber', 'lucky', 'steady', 'bright', 'north', 'calm', 'swift', 'bold', 'keen', 'merry', 'plain', 'sunny', 'brisk', 'gentle', 'wry'];
const NOUNS = ['otter', 'heron', 'fox', 'lynx', 'wren', 'finch', 'marten', 'crane', 'badger', 'plover', 'stoat', 'swift', 'robin', 'vole', 'tern', 'hare'];

/**
 * A pseudonymous public name for a user: stable, but it cannot be turned back into the
 * account without the secret. Never a Gemini account id.
 */
export function handleFor(user: string, secret: string): string {
  const h = createHmac('sha256', secret).update(user).digest();
  return `${ADJECTIVES[h[0]! % ADJECTIVES.length]}-${NOUNS[h[1]! % NOUNS.length]}-${10 + (h[2]! % 90)}`;
}
