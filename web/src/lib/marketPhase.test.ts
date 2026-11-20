import { describe, expect, it } from 'vitest';
import type { MarketEvent, Rung } from '../api/types';
import { anotherOpen, closesIn, marketNote, phaseOf } from './marketPhase';

const rung = (strike: number, state = 'active/open'): Rung => ({ symbol: `S${strike}`, label: `${strike}`, strike, bid: 0.4, ask: 0.42, open: state === 'active/open', state });
const ladder = (expiry: string | null, states: string[] = ['active/open', 'active/open', 'active/open']) => ({ expiry, rungs: states.map((s, i) => rung(100 + i, s)) });

// Local time, so the clock times in the sentences do not depend on where the tests run.
const now = new Date(2026, 10, 19, 21, 40).getTime();
const at = (h: number, m: number, day = 19) => new Date(2026, 10, day, h, m).toISOString();

describe('whether a ladder can take a bet', () => {
  it('is open while its close time is ahead and a contract is open', () => {
    expect(phaseOf(ladder(at(22, 0)), now)).toBe('open');
    expect(phaseOf(ladder(null), now)).toBe('open');
    expect(phaseOf(ladder(at(22, 0), ['active/open', 'active/post_only', 'settled/closed']), now)).toBe('open');
  });

  it('is closed once its close time has passed, whatever its contracts still say', () => {
    expect(phaseOf(ladder(at(21, 35)), now)).toBe('closed');
    expect(phaseOf(ladder(new Date(now).toISOString()), now)).toBe('closed');
  });

  it('is closed when every contract has finished, even before the listed close time', () => {
    expect(phaseOf(ladder(at(22, 0), ['settled/closed', 'settled/closed', 'settled/closed']), now)).toBe('closed');
    expect(phaseOf(ladder(null, ['active/closed', 'expired/closed', 'resolved/closed']), now)).toBe('closed');
  });

  it('is not open yet when nothing is open but something still may', () => {
    expect(phaseOf(ladder(at(22, 0), ['active/post_only', 'active/post_only', 'active/post_only']), now)).toBe('not_open');
    expect(phaseOf(ladder(at(22, 0), ['active/post_only', 'settled/closed', 'settled/closed']), now)).toBe('not_open');
    expect(phaseOf(ladder(at(22, 0), ['mystery', 'mystery', 'mystery']), now)).toBe('not_open');
  });
});

describe('what the page says about a ladder that cannot take a bet', () => {
  it('says nothing about an open one', () => {
    expect(marketNote(ladder(at(22, 0)), now, { another: false })).toBeNull();
  });

  it('a closed market says when it closed, in the viewer’s time, and never points at a market that is not there', () => {
    const alone = marketNote(ladder(at(21, 35)), now, { another: false })!;
    expect(alone.label).toBe('This market has closed');
    expect(alone.text).toBe('This market closed at 9:35 PM and takes no more bets. The next one appears here by itself when it opens.');
    expect(alone.text).not.toMatch(/above|next ladder/);

    const withOthers = marketNote(ladder(at(21, 0)), now, { another: true })!;
    expect(withOthers.text).toBe('This market closed at 9 PM and takes no more bets. Pick another market above.');
  });

  it('keeps what to do apart from what happened, so a builder can say that it closed only once', () => {
    expect(marketNote(ladder(at(21, 0)), now, { another: true })!.next).toBe('Pick another market above.');
    expect(marketNote(ladder(at(21, 0)), now, { another: false })!.next).toBe('The next one appears here by itself when it opens.');
    const post = marketNote(ladder(at(22, 0), ['active/post_only', 'active/post_only', 'active/post_only']), now, { another: false })!;
    expect(post.next).toMatch(/few minutes/);
    expect(post.next).not.toMatch(/not open/);
    for (const n of [marketNote(ladder(at(21, 0)), now, { another: true })!, post]) expect(n.text.endsWith(n.next!)).toBe(true);
  });

  it('names the day when it closed on another one, and no time when none is known', () => {
    expect(marketNote(ladder(at(17, 0, 18)), now, { another: false })!.text).toMatch(/^This market closed on Nov 18 at 5 PM and takes no more bets\./);
    const early = marketNote(ladder(at(22, 0), ['settled/closed', 'settled/closed', 'settled/closed']), now, { another: false })!;
    expect(early).toMatchObject({ phase: 'closed', label: 'This market has closed' });
    expect(early.text).toMatch(/^This market has closed and takes no more bets\./);
  });

  it('a new listing that is not trading yet opens in a few minutes, and the page says it will pick it up', () => {
    const n = marketNote(ladder(at(22, 0), ['active/post_only', 'active/post_only', 'active/post_only']), now, { another: false })!;
    expect(n).toMatchObject({ phase: 'not_open', label: 'Not open for bets yet' });
    expect(n.text).toMatch(/few minutes/);
  });

  it('an unknown state makes no promise about opening', () => {
    const n = marketNote(ladder(at(22, 0), ['mystery', 'mystery', 'mystery']), now, { another: true })!;
    expect(n.label).toBe('Not open for bets');
    expect(n.text).not.toMatch(/few minutes|by itself/);
    expect(n.text).toMatch(/Pick another market above/);
    expect(marketNote(ladder(at(22, 0), ['mystery', 'mystery', 'mystery']), now, { another: false })!.text).not.toMatch(/above/);
  });
});

describe('whether there is another market to point at', () => {
  const ev = (ticker: string, expiry: string, states?: string[]): MarketEvent => ({
    ticker,
    title: ticker,
    ...ladder(expiry, states),
    ladderOutOfOrder: false,
    pairs: [],
    offerableCount: 0,
    refusedCount: 0,
    refusedByReason: {},
  });

  it('counts only other ladders that are open', () => {
    const closed = ev('A', at(21, 35));
    const open = ev('B', at(22, 0));
    const shut = ev('C', at(22, 0), ['settled/closed', 'settled/closed', 'settled/closed']);
    expect(anotherOpen([closed], closed, now)).toBe(false);
    expect(anotherOpen([closed, shut], closed, now)).toBe(false);
    expect(anotherOpen([closed, open], closed, now)).toBe(true);
    expect(anotherOpen([open], open, now)).toBe(false);
  });
});

describe('the countdown beside the market picker', () => {
  it('counts down while the market is open', () => {
    expect(closesIn(ladder(at(22, 35)), now)).toBe('Closes in 55 min');
  });

  it('says nothing once every contract has finished, though the listed close time is still ahead', () => {
    // The exchange can finish a market early; "Closes in 55 min" beside a market that has closed would say the opposite.
    expect(closesIn(ladder(at(22, 35), ['settled/closed', 'settled/closed', 'settled/closed']), now)).toBeNull();
  });

  it('says nothing once the close time has passed, instead of a second "Closed"', () => {
    expect(closesIn(ladder(at(21, 35)), now)).toBeNull();
  });

  it('keeps counting down for a market that is listed but not trading yet', () => {
    expect(closesIn(ladder(at(22, 35), ['active/post_only', 'active/post_only', 'active/post_only']), now)).toBe('Closes in 55 min');
  });
});
