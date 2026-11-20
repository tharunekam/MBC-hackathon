import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, liveApi } from './client';

describe('what an error says', () => {
  it('keeps the executor’s own sentence for a refusal: it names the bet’s problem', () => {
    const e = new ApiError(400, { error: 'Bets are capped at $25 on this demo.', code: 'stake_too_large' });
    expect(e.message).toBe('Bets are capped at $25 on this demo.');
    expect(e.code).toBe('stake_too_large');
  });

  it('never keeps an error string that has no code: that is a proxy or a firewall, not the executor', () => {
    const firewall = new ApiError(403, { error: 'Forbidden: request blocked by firewall rule 1010 (ray 8a1b2c3d)' } as never);
    expect(firewall.message).toBe('You are not allowed to do that here.');
    expect(firewall.code).toBe('unreadable');
    expect(new ApiError(404, { error: 'Cannot GET /api/markets' } as never).message).toBe('We could not find that.');
    expect(new ApiError(400, { error: 'oops' } as never).message).toBe('That did not go through. Try again.');
  });

  it('a code that is not a string is no code', () => {
    const e = new ApiError(400, { error: 'x', code: 7 } as never);
    expect(e.code).toBe('unreadable');
    expect(e.message).toBe('That did not go through. Try again.');
  });

  it('never keeps the words of a busy or broken server, coded or not', () => {
    expect(new ApiError(500, { error: 'internal', code: 'internal_error' }).message).toBe('Something went wrong on our side. Try again in a moment.');
    expect(new ApiError(503, { error: 'Betting is paused for a moment.', code: 'paused' }).message).toBe('Something went wrong on our side. Try again in a moment.');
    expect(new ApiError(429, { error: 'Too many requests', code: 'rate_limited' }).message).toMatch(/Lots of people/);
    expect(new ApiError(0, null).code).toBe('network_error');
  });
});

describe('the live client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns a 403 from a firewall into one plain sentence', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Forbidden: request blocked by firewall' }), { status: 403 }));
    await expect(liveApi().markets()).rejects.toMatchObject({ status: 403, code: 'unreadable', message: 'You are not allowed to do that here.' });
  });

  it('sends a basket leg’s own price limit as it is given', async () => {
    let body: unknown;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ basket: {}, bets: [] }), { status: 201 });
    });
    await liveApi().placeBasket({ user: 'primary', legs: [{ product: 'range', event: 'E', low: 'a', high: 'b', stake: 10, maxPrice: 0.49 }, { event: 'E', condition: 'a', target: 'b', stake: 10, maxPrice: 0.52 }], requestId: 'attempt-0001' });
    expect((body as { legs: { maxPrice: number }[] }).legs.map((l) => l.maxPrice)).toEqual([0.49, 0.52]);
  });
});
