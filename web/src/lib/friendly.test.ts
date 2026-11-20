import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { friendly, sealProblem } from './friendly';

const err = (code: string, message = 'raw') => new ApiError(422, { error: message, code }, message);

describe('what a failed bet says', () => {
  it('says nothing was bought, and what to do', () => {
    expect(friendly(err('insufficient_depth'))).toMatch(/Nothing was bought. Try a smaller stake/);
    expect(friendly(err('market_closed'))).toMatch(/Nothing was bought/);
    expect(friendly(err('price_above_limit'))).toBe('The price moved while you were deciding. Nothing was bought. Check the new price and place the bet again.');
  });

  it('says both prices when the price moved out from under the person (the refusal carries the new one)', () => {
    // The page asked for at most 48¢ (the 46¢ it showed plus two cents); the exchange's live price was 49¢.
    const moved = new ApiError(422, { error: 'The live price is 0.493 per $1, above your limit of 0.480.', code: 'price_above_limit', refused: true, quote: { pricePaid: 0.493 } as never }, 'x');
    expect(friendly(moved, { product: 'parlay', shownPrice: 0.462 })).toBe('The price moved from 46¢ to 49¢ while you were deciding. Nothing was bought. Check the new price and place the bet again.');
    // Without the price that was shown, or without the new one in the refusal, it still says what happened, and nothing it could get wrong.
    expect(friendly(moved)).toBe('The price moved while you were deciding. Nothing was bought. Check the new price and place the bet again.');
    const bare = new ApiError(422, { error: 'x', code: 'price_above_limit', refused: true }, 'x');
    expect(friendly(bare, { shownPrice: 0.462 })).toBe('The price moved while you were deciding. Nothing was bought. Check the new price and place the bet again.');
    // Two prices that print the same are not "from 46¢ to 46¢".
    expect(friendly(moved, { shownPrice: 0.4931 })).not.toMatch(/from/);
    // The server's own sentence, with its three-decimal prices, never reaches the person.
    expect(friendly(moved, { shownPrice: 0.462 })).not.toMatch(/0\.4|live price|limit/);
  });

  it('asks a rising parlay for a higher target and a falling one for a lower target', () => {
    expect(friendly(err('price_too_high'))).toMatch(/further above the first level/);
    expect(friendly(err('price_too_high'), { product: 'parlay', direction: 'down' })).toMatch(/further below the first level/);
  });

  it('calls a parlay’s two prices the first level and the target, never a condition, a leg or a pair', () => {
    for (const code of ['offer_refused', 'markup_too_high', 'price_too_high', 'no_price', 'insufficient_depth', 'market_closed']) {
      for (const direction of ['up', 'down'] as const) {
        expect(friendly(err(code), { product: 'parlay', direction })).not.toMatch(/condition|\bleg\b|\bpart\b|\bpair\b/i);
      }
    }
  });

  it('says what the cap is when a stake is over it, not that prices are unavailable', () => {
    const said = friendly(new ApiError(400, { error: 'Bets are capped at $100 on this demo.', code: 'stake_too_large' }, 'x'));
    expect(said).toBe('Each bet is capped at $100 here. Nothing was bought. Enter a smaller stake.');
    expect(friendly(new ApiError(400, { error: 'Too much.', code: 'stake_too_large' }, 'x'))).toBe('That stake is above the most one bet can be here. Nothing was bought. Enter a smaller stake.');
    expect(friendly(new ApiError(400, { error: '"stake" must be a positive dollar amount.', code: 'invalid_stake' }, 'x'))).toMatch(/Nothing was bought. Enter a stake in dollars/);
  });

  it('speaks of levels for a range', () => {
    expect(friendly(err('markup_too_high'), { product: 'range' })).toMatch(/other levels/);
    expect(friendly(err('no_price'), { product: 'range' })).toMatch(/further apart/);
  });

  it('asks a range that costs too much for a narrower one, never a wider one', () => {
    const said = friendly(err('price_too_high'), { product: 'range' });
    expect(said).toMatch(/narrower/);
    expect(said).not.toMatch(/further apart/);
  });

  it('asks a breakout for levels further apart, and says nothing was bought', () => {
    expect(friendly(err('markup_too_high'), { product: 'breakout' })).toMatch(/breakout is not good value.*Nothing was bought.*other levels/);
    for (const code of ['price_too_high', 'no_price']) {
      const said = friendly(err(code), { product: 'breakout' });
      expect(said).toMatch(/Nothing was bought/);
      expect(said).toMatch(/further apart/);
      expect(said).not.toMatch(/target|condition|range/);
    }
  });

  it('never prints a server or developer string, whatever the code or status', () => {
    expect(friendly(err('something_new', 'Hedge order rejected: InsufficientFunds'), { product: 'parlay' })).toBe('We could not place that bet. Nothing was bought. Try again.');
    expect(friendly(new Error('boom'))).toBe('Something went wrong. Try again in a moment.');
    expect(friendly('x')).toBe('Something went wrong. Try again in a moment.');
    expect(friendly(new ApiError(400, { error: 'Those two contracts are not a linked pair in BTC', code: 'not_a_linked_pair' }, 'x'))).not.toMatch(/contract|pair|BTC/);
  });

  it('gives a busy, broken or unreachable server one plain sentence each', () => {
    const say = (status: number, body: { error: string; code: string } | null) => friendly(new ApiError(status, body));
    expect(say(0, null)).toMatch(/could not reach the server/);
    expect(say(429, { error: 'Too many requests', code: 'rate_limited' })).toBe('Lots of people are betting right now. Wait a few seconds and try again.');
    expect(say(500, { error: 'Internal error', code: 'internal' })).toBe('Something went wrong on our side. Try again in a moment.');
    expect(say(503, null)).toBe('Something went wrong on our side. Try again in a moment.');
    expect(say(504, null)).not.toMatch(/504|answered/);
  });
});

describe('a basket leg that did not end open', () => {
  it('is told by the status its bet ended in, in the same plain words as a single bet', () => {
    expect(friendly(err('unwound'))).toBe('The second order could not be placed, so the first one was sold back.');
    // By what is missing, not "protected": a Stake Back's stake comes back only through its second order; the others have no stake back.
    expect(friendly(err('unhedged'), { product: 'parlay' })).toBe('Only the first order went through, so the stake does not come back if the first level fails. You can sell it back in My bets.');
    expect(friendly(err('unhedged'), { product: 'range' })).toBe('Only the first order went through, so this bet is only half placed. You can sell it back in My bets.');
    for (const product of ['parlay', 'range', 'breakout'] as const) expect(friendly(err('unhedged'), { product })).not.toMatch(/protected|filled/);
    expect(friendly(err('failed'))).toBe('The first order did not go through. Nothing was bought.');
  });

  it('never says "fill" to a person: the market "covers" a bet and an order "goes through"', () => {
    for (const code of ['insufficient_depth', 'failed', 'unhedged']) expect(friendly(err(code), { product: 'parlay' })).not.toMatch(/\bfill/i);
  });

  it('tells a price that moved in a basket to place the basket again, not the bet', () => {
    expect(friendly(err('price_above_limit'), { product: 'parlay', basket: true })).toBe('The price moved while you were deciding. Nothing was bought. Check the new price and place the basket again.');
  });
});

describe('a paused executor', () => {
  const paused = new ApiError(503, { error: 'Betting is paused for a moment. Try again soon.', code: 'paused' });

  it('says betting is paused and nothing was bought: its own explicit answer is not a lost one', () => {
    expect(friendly(paused, { product: 'parlay' })).toBe('Betting is paused for a moment. Nothing was bought. Try again soon.');
    expect(friendly(paused, { basket: true })).toBe('Betting is paused for a moment. Nothing was bought. Try again soon.');
    // It never falls to the busy-server sentence, which would not say whether anything was bought.
    expect(friendly(paused)).not.toMatch(/something went wrong/i);
  });

  it('a 503 that is not the executor’s own answer still says only that something went wrong', () => {
    expect(friendly(new ApiError(503, null), { product: 'parlay' })).toBe('Something went wrong on our side. Try again in a moment.');
  });
});

describe('a request id used for a different bet', () => {
  it('says nothing was bought and what to do, without printing the server’s words', () => {
    const reused = new ApiError(409, { error: 'That requestId was used for a different request.', code: 'request_id_reused' });
    expect(friendly(reused, { product: 'range' })).toBe('That request was already used for a different bet. Nothing was bought. Check the bet and place it again.');
  });
});

describe('a page that only reads', () => {
  it('never says "place that bet" under a heading about loading something', () => {
    // A coded 4xx on a read (the loaded markets, My bets, the leaderboard): it did not go through, and there is nothing to buy.
    const coded = new ApiError(400, { error: 'x is required', code: 'missing_field' });
    expect(friendly(coded)).toBe('That did not go through. Try again.');
    expect(friendly(coded)).not.toMatch(/bet|bought/i);
  });

  it('prints nothing a proxy or a firewall said: a 4xx with an error string and no code is a plain sentence of ours', () => {
    const firewall = new ApiError(403, { error: 'Forbidden: request blocked by firewall rule 1010 (ray 8a1b2c3d)' } as never);
    expect(friendly(firewall)).toBe('You are not allowed to do that here.');
    expect(friendly(firewall, { product: 'parlay' })).not.toMatch(/firewall|ray|1010/);
    const notFound = new ApiError(404, { error: 'Cannot GET /api/markets' } as never);
    expect(friendly(notFound)).toBe('We could not find that.');
    expect(friendly(new ApiError(400, { error: 'Bad things happened' } as never))).toBe('That did not go through. Try again.');
  });

  it('a bet being placed still says so', () => {
    expect(friendly(new ApiError(422, { error: 'x', code: 'something_new' }), { product: 'range' })).toBe('We could not place that bet. Nothing was bought. Try again.');
    expect(friendly(new ApiError(422, { error: 'x', code: 'something_new' }), { basket: true })).toBe('We could not place that bet. Nothing was bought. Try again.');
  });
});

describe('a call that would not seal', () => {
  it('says the market has closed when the chain service refuses a call for good, and offers no second try', () => {
    const late = new ApiError(409, { error: 'The market closed at 9:35 PM.', code: 'too_late' });
    expect(sealProblem(late)).toEqual({ text: 'This market has closed, so the call can no longer be sealed. Your bet is placed.', final: true });
  });

  it('says it could not be sealed yet, with a second try, for anything else, and prints nothing the server said', () => {
    for (const e of [new ApiError(0, null), new ApiError(500, { error: 'ECONNRESET at chain.ts:412', code: 'internal_error' }), new ApiError(409, { error: 'x', code: 'bet_not_eligible' }), new Error('boom'), null]) {
      const said = sealProblem(e);
      expect(said).toEqual({ text: 'We could not seal this call yet, but your bet is placed.', final: false });
    }
  });
});
