/**
 * A bounded wait for a bet's second order. OFF unless GIVEN_SECOND_LEG_WAIT_MS is set above 0.
 *
 * Why it exists: every bet is two orders sent one after the other. On the Gemini sandbox on 2026-11-20 a breakout's first
 * order filled, the second contract was then found post-only (its ladder had been listed about 14 minutes and was flipping
 * between open and post-only), so the second order was never sent and the position was sold straight back on a wide book:
 * $1.55 lost of a $3 bet. With the wait on, a second leg that finds its contract post-only re-reads the event every half
 * second until the contract is open or the wait is used up, and then carries on exactly as it always did.
 *
 * What it never does: loosen the price limit, raise the size, add attempts, or wait on a contract that is closed for good.
 * The three placers (bets.ts, range-bet.ts, breakout-bet.ts) call `waitForSecondLeg` only when the setting is above 0, so
 * with the setting at 0 the order path is the one that was verified on the sandbox, line for line.
 *
 * NOT yet run on the real sandbox: see "Waiting for the second order" in executor/README.md before switching it on.
 */
import type { Deps } from './bets.ts';
import type { GeminiContract } from './gemini/types.ts';
import type { BetRecord } from './ledger.ts';
import { toRung } from './pairs.ts';
import type { Rung } from './pairs.ts';

/** The setting can never ask for more than this, whatever it says. */
export const MAX_SECOND_LEG_WAIT_MS = 15_000;
/** How long to pause between two reads of the event while waiting. */
export const SECOND_LEG_POLL_MS = 500;

/** The setting as a whole number of milliseconds from 0 to 15000. Anything that is not a positive number is 0: off. */
export function clampSecondLegWaitMs(value: unknown): number {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : 0;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_SECOND_LEG_WAIT_MS, Math.floor(ms));
}

const POST_ONLY = /^post[_\s-]?only$/i;

/**
 * The one place that decides whether a contract that is not taking orders is worth waiting for.
 *
 * True only when the contract exists, Gemini still lists it as `active`, it carries no result, and its market state is
 * post-only: the book is visible but taker orders are refused, which on the sandbox's hourly ladders came and went within
 * seconds. Everything else is final, as it always was: a missing contract, any other status (settled, closed, expired,
 * resolved, ...), a contract that has a result, and any other market state ("closed", or one this service has never seen).
 */
export function isTemporarilyClosed(contract: GeminiContract | null | undefined): boolean {
  if (!contract) return false;
  if (contract.status !== 'active') return false;
  if (contract.resolvedAt || contract.resolutionSide === 'yes' || contract.resolutionSide === 'no') return false;
  return POST_ONLY.test(contract.marketState ?? '');
}

/** What one bet's second leg may still spend waiting. Shared by every attempt of that leg, so the total is bounded. */
export interface SecondLegWait {
  leftMs: number;
}

export const secondLegWaitOf = (deps: Pick<Deps, 'secondLegWaitMs'>): SecondLegWait => ({ leftMs: clampSecondLegWaitMs(deps.secondLegWaitMs) });

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Called from a second-leg loop with the contract and rung it has just read. When that contract is temporarily closed
 * (`isTemporarilyClosed`) and there is wait left, re-reads the event every `SECOND_LEG_POLL_MS` until the contract is
 * open, turns out to be closed for good, or the wait is used up. Returns the rung from the last read, which the caller
 * checks exactly as it checks one it read itself: an open one is the fresh book the order is priced from, and one that
 * is still not open ends the leg as before (sold back or left unhedged, as the request said).
 *
 * In every other case it returns the rung it was given, at once, having read nothing and recorded nothing.
 *
 * `deps.exchange` is the bet's own view of the ladder (the mirror for a falling parlay), as it is in the loop calling this.
 * What the wait came to is written on the bet (`secondLegWait`) and saved before any order follows it. A re-read that
 * fails is treated as "not open yet": the wait never adds a way for a bet to stop half-way.
 */
export async function waitForSecondLeg(
  deps: Deps,
  bet: BetRecord,
  symbol: string,
  contract: GeminiContract | undefined,
  rung: Rung | null,
  wait: SecondLegWait,
): Promise<Rung | null> {
  if (wait.leftMs <= 0 || !rung || rung.open || !isTemporarilyClosed(contract)) return rung;

  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const budget = wait.leftMs;
  const earlier = bet.secondLegWait ?? { waitedMs: 0, reads: 0, opened: false };
  // On disk before the first pause, so a bet interrupted while it waits says what it was doing.
  bet.secondLegWait = { waitedMs: earlier.waitedMs, reads: earlier.reads, opened: false };
  deps.ledger.save();

  const startedAt = now().getTime();
  let slept = 0;
  // The pauses asked for, or the time that really passed if that is longer (each read takes time too). Never less than
  // the pauses, so a clock that stands still or steps back cannot stretch the wait.
  const used = (): number => Math.min(budget, Math.max(slept, now().getTime() - startedAt));
  let reads = 0;
  let current: Rung | null = rung;
  while (used() < budget) {
    const pause = Math.min(SECOND_LEG_POLL_MS, budget - used());
    await sleep(pause);
    slept += pause;
    reads++;
    let seen: GeminiContract | undefined;
    try {
      seen = (await deps.exchange.getEvent(bet.eventTicker)).contracts.find((c) => c.instrumentSymbol === symbol);
    } catch {
      continue; // could not be read just now: no better and no worse than still closed
    }
    current = seen ? toRung(seen) : null;
    if (!current || current.open || !isTemporarilyClosed(seen)) break; // open, or closed for good, or gone
  }

  const waited = used();
  wait.leftMs = Math.max(0, budget - waited);
  bet.secondLegWait = { waitedMs: Math.round(earlier.waitedMs + waited), reads: earlier.reads + reads, opened: current?.open === true };
  deps.ledger.save();
  return current;
}
