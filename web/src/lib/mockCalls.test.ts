import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../api/mock';
import type { Bet } from '../api/types';
import { calledResult, canRevealCall, outcomeOf, sellOrdersWords, soldCallWords } from './betsView';
import { sealedWords, unrevealed } from './sealed';

/**
 * The demo data's calls: what the leaderboard says about how many were sealed, and the call of a bet that was sold back.
 * The demo data stands in for the executor and the chain service, so it has to tell the same story they do: selling a bet
 * ends the bet, not the call, and the call can be revealed once the market has a result.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('the demo leaderboard', () => {
  it('says how many calls each player sealed, beside how many they revealed', async () => {
    const { rows } = await mockApi().leaderboard();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(r.sealed, `${r.handle} carries a sealed count`).toBeTypeOf('number');
      expect(r.refunded, `${r.handle} carries a refunded count`).toBeTypeOf('number');
      expect(r.sealed!).toBeGreaterThanOrEqual(r.calls + r.refunded!);
      expect(sealedWords(r)).not.toBeNull();
    }
    const others = rows.filter((r) => r.handle !== 'you');
    // Most have a call or two not revealed, one has revealed every call, one has had a call refunded.
    expect(others.filter((r) => unrevealed(r)! > 0).length).toBeGreaterThan(others.length / 2);
    expect(others.some((r) => sealedWords(r) === 'every call revealed')).toBe(true);
    expect(others.some((r) => r.refunded! > 0)).toBe(true);
  });

  it('counts your own row from the calls My bets shows', async () => {
    const api = mockApi();
    const { calls } = await api.calls();
    const you = (await api.leaderboard()).rows.find((r) => r.handle === 'you')!;
    expect(you.calls).toBe(calls.filter((c) => c.state === 'revealed').length);
    expect(you.sealed).toBe(calls.length);
    expect(you.refunded).toBe(calls.filter((c) => c.state === 'void').length);
    expect(you.refunded).toBeGreaterThan(0);
  });

  it('gives each recent call the event and contracts its reveal published', async () => {
    const api = mockApi();
    const you = (await api.leaderboard()).rows.find((r) => r.handle === 'you')!;
    expect(you.recent!.length).toBeGreaterThan(0);
    for (const c of you.recent!) {
      const shown = await api.reveal(c.signature);
      expect([c.event, c.condition, c.target]).toEqual([shown.event, shown.condition, shown.target]);
      expect(c.betId).toBe(shown.betId);
      expect(c.outcome).toBe(shown.outcome);
    }
  });
});

describe('the demo data: a bet that was sold back', () => {
  it('seeds one whose market has settled since, with its call still sealed and ready to reveal', async () => {
    const api = mockApi();
    const sold = (await api.bets()).bets.find((b) => b.status === 'cashed_out')!;
    expect(sold, 'the demo data has a sold-back bet').toBeTruthy();
    expect(sold.settlement).toBeUndefined();
    expect(sold.cashOut).toMatchObject({ complete: true });
    expect(sellOrdersWords(sold)).toBe('as two sell orders');
    expect(sold.scorable).toBe(true);
    expect(calledResult(sold)).toBe('won');
    expect(canRevealCall(sold)).toBe(true);
    // Where it says the price ended agrees with the call having come off: at or above the target.
    expect(sold.called!.finishedAt).toBeGreaterThanOrEqual(sold.target.strike);
    expect(soldCallWords(sold)).toMatch(/^The market has since settled: it reached \$[\d,]+, so the call came off\.$/);

    const call = (await api.calls()).calls.find((c) => c.betId === sold.id)!;
    expect(call.state).toBe('committed');
    const before = (await api.leaderboard()).rows.find((r) => r.handle === 'you')!;

    const revealed = await api.revealCall(call.id);
    expect(revealed.state).toBe('revealed');
    expect(revealed.reveal).toMatchObject({ outcome: 1 });
    expect(revealed.reveal!.edge).toBeCloseTo(1 - revealed.reveal!.fairPriceAtEntry, 2);
    // Revealing it again changes nothing, and the bet is still a bet that was sold: it is never paid.
    expect((await api.revealCall(call.id)).reveal!.signature).toBe(revealed.reveal!.signature);
    expect(outcomeOf((await api.bets()).bets.find((b) => b.id === sold.id)!)).toBe('cashed');

    const after = (await api.leaderboard()).rows.find((r) => r.handle === 'you')!;
    expect(after.calls).toBe(before.calls + 1);
    expect(after.sealed).toBe(before.sealed);
    expect(after.recent![0]).toMatchObject({ signature: revealed.reveal!.signature, betId: sold.id, event: sold.eventTicker, target: sold.target.symbol });
  }, 15_000);

  it('keeps the call sealed until the market settles, then gives it its result and lets it be revealed', async () => {
    const api = mockApi();
    const ev = (await api.markets()).events[0]!;
    const pair = ev.pairs.find((p) => p.quote.offerable)!;
    const { bet } = await api.placeBet({ user: 'primary', event: ev.ticker, condition: pair.condition.symbol, target: pair.target.symbol, stake: 10 });
    const call = await api.commitCall(bet.id);
    await api.cashOut(bet.id);
    const find = async (): Promise<Bet> => (await api.bets()).bets.find((b) => b.id === bet.id)!;

    // Sold, and the market has not settled: there is nothing to score yet.
    expect((await find()).called).toBeUndefined();
    expect(soldCallWords(await find())).toBe('Its call can be revealed once the market settles.');
    await expect(api.revealCall(call.id)).rejects.toMatchObject({ status: 409, code: 'cashed_out' });
    const early = (await api.settle()) as Awaited<ReturnType<typeof api.settle>> & { called: Bet[] };
    expect(early.called.map((b) => b.id)).not.toContain(bet.id);

    // Later, when the demo data settles its markets. Only the clock is moved; the demo's own waits still run.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 20_000);
    const done = (await api.settle()) as Awaited<ReturnType<typeof api.settle>> & { called: Bet[] };
    expect(done.called.map((b) => b.id)).toContain(bet.id);
    expect(done.settled.map((b) => b.id)).not.toContain(bet.id);

    const sold = await find();
    expect(sold.status).toBe('cashed_out');
    expect(sold.settlement).toBeUndefined();
    expect(sold.scorable).toBe(true);
    expect(sold.called!.finishedAt).toBeGreaterThan(0);
    // A second pass has nothing more to say about it.
    expect(((await api.settle()) as typeof done).called).toEqual([]);

    const result = calledResult(sold)!;
    if (result === 'refunded') {
      // The first level failed: the call does not count, exactly as for a bet that was held.
      await expect(api.revealCall(call.id)).rejects.toMatchObject({ status: 409, code: 'void_call', message: 'The first half failed, so this call does not count.' });
      expect((await api.calls()).calls.find((c) => c.id === call.id)!.state).toBe('void');
    } else {
      const revealed = await api.revealCall(call.id);
      expect(revealed.state).toBe('revealed');
      expect(revealed.reveal!.outcome).toBe(result === 'won' ? 1 : 0);
    }
  }, 30_000);
});
