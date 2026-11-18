/**
 * In-browser stand-in for the executor and the chain service, with the same
 * response shapes (see `types.ts`). The UI labels everything it serves as demo
 * data. It exists so the product can be built, reviewed and demoed before the
 * hosted services are ready, and as the offline fallback for a bad network.
 *
 * Prices are generated from a drifting spot with a normal-distribution ladder;
 * quotes use the same maths as the executor (`lib/pricing.ts`).
 */
import { estimate, PRODUCTION_FEE_COEF } from '../lib/pricing';
import { ApiError, type Api } from './client';
import type {
  Bet,
  CallRecord,
  LeaderboardResponse,
  MarketEvent,
  OfferQuote,
  Pair,
  PairLeg,
  PlaceBetRequest,
  QuoteResponse,
  Rung,
} from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (x: number) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------ ladders

interface Asset {
  key: string;
  name: string;
  spot: number;
  step: number;
  lowest: number;
  rungs: number;
  sigma: number;
  money: (k: number) => string;
}

const ASSETS: Asset[] = [
  { key: 'BTC', name: 'BTC', spot: 63240, step: 500, lowest: 61500, rungs: 8, sigma: 0.012, money: (k) => `$${k.toLocaleString('en-US')}` },
  { key: 'ETH', name: 'ETH', spot: 1806, step: 20, lowest: 1740, rungs: 8, sigma: 0.012, money: (k) => `$${k.toLocaleString('en-US')}` },
];

// Abramowitz-Stegun approximation of the normal CDF.
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function nextHour(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function hourLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'America/New_York' }).format(d).replace(' ', '').toLowerCase();
}

/** The spot drifts a little so the ladder moves while you watch. */
const spotNow = (a: Asset, t: number) => a.spot * (1 + 0.0011 * Math.sin(t / 15000 + a.step) + 0.0006 * Math.sin(t / 4100));

export const mockSpot = (key: string, t = Date.now()) => {
  const a = ASSETS.find((x) => x.key === key) ?? ASSETS[0]!;
  return spotNow(a, t);
};

function buildRungs(a: Asset, eventTicker: string, t: number): Rung[] {
  const s = spotNow(a, t);
  const out: Rung[] = [];
  for (let i = 0; i < a.rungs; i++) {
    const strike = a.lowest + i * a.step;
    const mid = 1 - normCdf(Math.log(strike / s) / a.sigma);
    const half = 0.02 - 0.01 * 4 * mid * (1 - mid);
    const bid = Math.max(0.01, cents(Math.floor((mid - half) * 100) / 100));
    const ask = Math.min(0.99, cents(Math.ceil((mid + half) * 100) / 100));
    out.push({
      symbol: `GEMI-${eventTicker}-HI${strike}`,
      label: `${a.money(strike)} or above`,
      strike,
      bid,
      ask,
      open: true,
      state: 'active/open',
    });
  }
  return out;
}

function toLeg(r: Rung): PairLeg {
  return { symbol: r.symbol, label: r.label, strike: r.strike, bid: r.bid, ask: r.ask };
}

function offerFrom(cond: Rung, target: Rung): OfferQuote {
  const e = estimate({ bid: cond.bid, ask: cond.ask }, { bid: target.bid, ask: target.ask }, 0);
  const base = { feeCoefCharged: 0 };
  if (e === null) {
    return {
      ...base,
      verdict: 'refuse',
      reasons: [{ code: 'no_price', message: 'The outcome costs as much as the condition.' }],
      warnings: [],
      offerable: false,
      overridden: false,
      chanceCondition: null,
      chanceBothHappen: null,
      fairPrice: null,
      pricePaid: null,
      allInPrice: null,
      markup: null,
      markupPct: null,
      cashOutPer100: null,
      cashOutPer100AtProductionFees: null,
    };
  }
  return {
    ...base,
    verdict: e.verdict,
    reasons: e.refusal ? [{ code: 'markup_too_high', message: e.refusal }] : [],
    warnings: e.verdict === 'warn' ? [`Costs ${(e.markup * 100).toFixed(1)} cents (${(e.markupPct * 100).toFixed(1)}%) more than the fair price with fees.`] : [],
    offerable: e.verdict !== 'refuse',
    overridden: false,
    chanceCondition: e.chanceCondition,
    chanceBothHappen: e.chanceBothHappen,
    fairPrice: e.fairPrice,
    pricePaid: e.pricePaid,
    allInPrice: e.allIn,
    markup: e.markup,
    markupPct: e.markupPct,
    cashOutPer100: e.cashOutPer100,
    cashOutPer100AtProductionFees: null,
  };
}

function buildEvent(a: Asset, t: number): MarketEvent {
  const expiry = nextHour(new Date(t));
  const ticker = `${a.key}${expiry.toISOString().slice(2, 13).replace(/[-T]/g, '')}00`;
  const rungs = buildRungs(a, ticker, t);
  const pairs: Pair[] = [];
  for (let i = 0; i < rungs.length; i++) {
    for (let j = i + 1; j < rungs.length; j++) {
      const c = rungs[i]!;
      const b = rungs[j]!;
      pairs.push({ condition: toLeg(c), target: toLeg(b), quote: offerFrom(c, b) });
    }
  }
  const offerable = pairs.filter((p) => p.quote.offerable);
  const refusedByReason: Record<string, number> = {};
  for (const p of pairs) for (const r of p.quote.reasons) refusedByReason[r.code] = (refusedByReason[r.code] ?? 0) + 1;
  return {
    ticker,
    title: `${a.name} price today at ${hourLabel(expiry)} EST`,
    category: 'Crypto',
    expiry: expiry.toISOString(),
    rungs,
    ladderOutOfOrder: false,
    pairs,
    offerableCount: offerable.length,
    refusedCount: pairs.length - offerable.length,
    refusedByReason,
  };
}

// ------------------------------------------------------------------ ids and hashes

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeSignature = () => Array.from(crypto.getRandomValues(new Uint8Array(88)), (b) => B58[b % B58.length]).join('');
const fakeOrderId = () => `${Math.floor(1e17 + Math.random() * 9e17)}`;
const WORDS_A = ['quiet', 'amber', 'lucky', 'steady', 'bright', 'north', 'calm', 'swift'];
const WORDS_B = ['otter', 'heron', 'fox', 'lynx', 'wren', 'finch', 'marten', 'crane'];

// ------------------------------------------------------------------ the mock service

export function mockApi(): Api {
  const startedAt = Date.now();
  const bets: Bet[] = [];
  const calls: CallRecord[] = [];
  let seeded = false;

  const events = (t = Date.now()) => ASSETS.map((a) => buildEvent(a, t));
  const findPair = (ev: MarketEvent, condition: string, target: string) => {
    const c = ev.rungs.find((r) => r.symbol === condition);
    const b = ev.rungs.find((r) => r.symbol === target);
    if (!c || !b || b.strike <= c.strike) throw new ApiError(400, { error: 'Those two contracts are not a linked pair.', code: 'not_a_linked_pair' }, 'bad pair');
    return { c, b };
  };

  function plan(stake: number, c: Rung, b: Rung) {
    const offer = offerFrom(c, b);
    const price = offer.pricePaid ?? 1;
    const qB = Math.floor((stake / price) * 100) / 100;
    const qA = cents(stake); // hedge contracts equal the stake: a NO on the condition pays $1 each
    const cost = cents(qB * (b.ask ?? 0) + qA * (1 - (c.bid ?? 0)));
    const prodFee =
      Math.ceil(PRODUCTION_FEE_COEF * qB * (b.ask ?? 0) * (1 - (b.ask ?? 0)) * 100) / 100 +
      Math.ceil(PRODUCTION_FEE_COEF * qA * (1 - (c.bid ?? 0)) * (c.bid ?? 0) * 100) / 100;
    return { offer, qB, qA, cost, prodFee: cents(prodFee) };
  }

  function makeBet(args: { id: string; ev: MarketEvent; c: Rung; b: Rung; stake: number; createdAt: Date; outcome?: 'won' | 'refunded' | 'lost' | 'open' }): Bet {
    const { offer, qB, qA, cost, prodFee } = plan(args.stake, args.c, args.b);
    const sent = args.createdAt.toISOString();
    const legs: Bet['legs'] = [
      { clientOrderId: `gv-${args.id}-out`, role: 'outcome', symbol: args.b.symbol, side: 'buy', outcome: 'yes', limitPrice: args.b.ask ?? 0, quantityRequested: qB, quantityFilled: qB, avgPrice: args.b.ask, fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
      { clientOrderId: `gv-${args.id}-hdg`, role: 'hedge', symbol: args.c.symbol, side: 'buy', outcome: 'no', limitPrice: cents(1 - (args.c.bid ?? 0)), quantityRequested: qA, quantityFilled: qA, avgPrice: cents(1 - (args.c.bid ?? 0)), fee: 0, status: 'filled', orderId: fakeOrderId(), sentAt: sent },
    ];
    const bet: Bet = {
      id: args.id,
      user: 'primary',
      createdAt: sent,
      eventTicker: args.ev.ticker,
      eventTitle: args.ev.title,
      expiry: args.ev.expiry,
      condition: { symbol: args.c.symbol, label: args.c.label, strike: args.c.strike },
      target: { symbol: args.b.symbol, label: args.b.label, strike: args.b.strike },
      requestedStake: args.stake,
      quotedPrice: offer.pricePaid ?? 0,
      status: 'open',
      legs,
      cost,
      payoffs: { stake: cost, ifConditionFails: cents(qA - cost), ifBothHit: cents(qB - cost), ifConditionOnly: -cost, conditionalPrice: offer.pricePaid, hedged: true },
      offer,
      scorable: false,
      flow: { orders: 2, filled: 2, contracts: cents(qB + qA), premium: cost, feesAtProductionRates: prodFee },
    };
    if (args.outcome && args.outcome !== 'open') {
      const conditionResolved = args.outcome === 'refunded' ? 'no' : 'yes';
      const targetResolved = args.outcome === 'won' ? 'yes' : 'no';
      const payout = cents((targetResolved === 'yes' ? qB : 0) + (conditionResolved === 'no' ? qA : 0));
      bet.status = 'settled';
      bet.scorable = true;
      bet.settlement = { conditionResolved, targetResolved, payout, profit: cents(payout - cost), settledAt: args.ev.expiry ?? sent };
    }
    return bet;
  }

  function seed() {
    if (seeded) return;
    seeded = true;
    const base = events();
    const btc = base[0]!;
    const eth = base[1]!;
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const pick = (ev: MarketEvent, ci: number, bi: number) => ({ ev, c: ev.rungs[ci]!, b: ev.rungs[bi]! });
    const history: [Parameters<typeof makeBet>[0]['outcome'], ReturnType<typeof pick>, number, number][] = [
      ['won', pick(btc, 1, 3), 25, 5],
      ['refunded', pick(btc, 5, 6), 25, 4],
      ['lost', pick(eth, 2, 3), 15, 3],
      ['open', pick(btc, 3, 5), 20, 0.3],
    ];
    history.forEach(([outcome, p, stake, ago], i) => {
      const bet = makeBet({ id: `demo${i + 1}`, ev: p.ev, c: p.c, b: p.b, stake, createdAt: hoursAgo(ago), outcome });
      bet.eventTitle = i === 3 ? bet.eventTitle : bet.eventTitle.replace(/at \d+(am|pm)/, (_, ap) => `at ${ap === 'am' ? '9am' : '2pm'}`);
      bets.push(bet);
      const call: CallRecord = {
        id: `call-demo${i + 1}`,
        handle: 'you',
        betId: bet.id,
        state: 'committed',
        commitHash: hex(32),
        commitSignature: fakeSignature(),
        committedAt: bet.createdAt,
      };
      if (outcome === 'won' || outcome === 'lost') {
        const fair = bet.offer?.fairPrice ?? 0.5;
        const o = outcome === 'won' ? 1 : 0;
        call.state = 'revealed';
        call.reveal = { signature: fakeSignature(), revealedAt: new Date(Date.now() - 1800_000).toISOString(), eventTitle: bet.eventTitle, conditionLabel: bet.condition.label, targetLabel: bet.target.label, fairPriceAtEntry: fair, outcome: o, edge: cents(o - fair) };
      }
      if (outcome === 'refunded') call.state = 'void';
      calls.push(call);
    });
  }

  const handleFor = (i: number) => `${WORDS_A[i % WORDS_A.length]}-${WORDS_B[(i * 3 + 1) % WORDS_B.length]}-${(i * 37 + 11) % 90}`;

  return {
    mode: 'mock',

    async health() {
      return { ok: true, venue: 'Demo data', sandbox: true, users: [{ user: 'primary', connected: true }], time: new Date().toISOString() };
    },

    async markets(event) {
      await sleep(120);
      seed();
      const all = events();
      const evs = event ? all.filter((e) => e.ticker === event) : all;
      if (event && evs.length === 0) throw new ApiError(404, { error: `Gemini has no event "${event}".`, code: 'unknown_event' }, 'unknown');
      return {
        venue: 'Demo data',
        asOf: new Date().toISOString(),
        feeCoefCharged: 0,
        totals: { events: evs.length, eventsWithOffers: evs.filter((e) => e.offerableCount > 0).length, offerable: evs.reduce((n, e) => n + e.offerableCount, 0), refused: evs.reduce((n, e) => n + e.refusedCount, 0) },
        events: evs,
      };
    },

    async quote({ event, condition, target, stake }): Promise<QuoteResponse> {
      await sleep(180);
      const ev = events().find((e) => e.ticker === event);
      if (!ev) throw new ApiError(404, { error: `Gemini has no event "${event}".`, code: 'unknown_event' }, 'unknown');
      const { c, b } = findPair(ev, condition, target);
      const offer = offerFrom(c, b);
      let stakePlan: QuoteResponse['stake'] = null;
      let depth: QuoteResponse['depth'] = null;
      if (stake !== undefined && offer.pricePaid !== null) {
        const p = plan(stake, c, b);
        const maxStake = 40 + Math.round(Math.abs(Math.sin(c.strike)) * 60);
        depth = { outcomeAvailable: 120, conditionAvailable: 400, maxStake };
        const capped = Math.min(stake, maxStake);
        const pc = plan(capped, c, b);
        stakePlan = {
          requested: stake,
          reduced: capped < stake,
          outcomeContracts: pc.qB,
          hedgeContracts: pc.qA,
          cost: pc.cost,
          ifBothHit: cents(pc.qB - pc.cost),
          ifConditionFails: cents(pc.qA - pc.cost),
          ifConditionOnly: -pc.cost,
          feesAtProductionRates: p.prodFee,
          cashOutNow: offer.cashOutPer100 === null ? null : cents((offer.cashOutPer100 * pc.cost) / 100),
        };
      }
      return { venue: 'Demo data', asOf: new Date().toISOString(), event: { ticker: ev.ticker, title: ev.title, expiry: ev.expiry }, condition: toLeg(c), target: toLeg(b), quote: offer, stake: stakePlan, depth };
    },

    async placeBet(req: PlaceBetRequest) {
      seed();
      await sleep(1900);
      const ev = events().find((e) => e.ticker === req.event);
      if (!ev) throw new ApiError(404, { error: `Gemini has no event "${req.event}".`, code: 'unknown_event' }, 'unknown');
      const { c, b } = findPair(ev, req.condition, req.target);
      const offer = offerFrom(c, b);
      if (!offer.offerable) throw new ApiError(422, { error: offer.reasons[0]?.message ?? 'This bet is not on offer.', code: offer.reasons[0]?.code ?? 'offer_refused', refused: true, quote: offer }, 'refused');
      if (req.stake > 100) throw new ApiError(400, { error: 'Demo bets are capped at $100.', code: 'invalid_stake' }, 'stake');
      const bet = makeBet({ id: `d${hex(3)}`, ev, c, b, stake: req.stake, createdAt: new Date() });
      bets.push(bet);
      return { bet, stakeReduced: null };
    },

    async bets() {
      seed();
      await sleep(100);
      return { bets: [...bets].reverse() };
    },

    async settle() {
      seed();
      await sleep(900);
      const settled: Bet[] = [];
      for (const bet of bets) {
        if (bet.status !== 'open' || Date.now() - new Date(bet.createdAt).getTime() < 15_000) continue;
        const a = ASSETS.find((x) => bet.eventTitle.startsWith(x.name)) ?? ASSETS[0]!;
        const s = spotNow(a, Date.now());
        const conditionResolved = s >= bet.condition.strike ? 'yes' : 'no';
        const targetResolved = s >= bet.target.strike ? 'yes' : 'no';
        const qB = bet.legs[0]?.quantityFilled ?? 0;
        const qA = bet.legs[1]?.quantityFilled ?? 0;
        const payout = cents((targetResolved === 'yes' ? qB : 0) + (conditionResolved === 'no' ? qA : 0));
        bet.status = 'settled';
        bet.scorable = true;
        bet.settlement = { conditionResolved, targetResolved, payout, profit: cents(payout - bet.cost), settledAt: new Date().toISOString() };
        const call = calls.find((c) => c.betId === bet.id);
        if (call && conditionResolved === 'no') call.state = 'void';
        settled.push(bet);
      }
      return { settled, needsReview: [], stillOpen: bets.filter((b) => b.status === 'open').length };
    },

    async flow() {
      seed();
      await sleep(80);
      const real = bets.filter((b) => b.status !== 'failed');
      return {
        venue: 'Demo data',
        user: null,
        bets: real.length,
        ordersSent: real.reduce((n, b) => n + b.flow.orders, 0),
        ordersFilled: real.reduce((n, b) => n + b.flow.filled, 0),
        contracts: cents(real.reduce((n, b) => n + b.flow.contracts, 0)),
        premium: cents(real.reduce((n, b) => n + b.flow.premium, 0)),
        feesAtProductionRates: cents(real.reduce((n, b) => n + b.flow.feesAtProductionRates, 0)),
        feesCharged: 0,
        productionFeeCoef: PRODUCTION_FEE_COEF,
        note: 'Demo data. On the Gemini sandbox no fees are charged; feesAtProductionRates is what the same fills would pay at Gemini\'s published taker rate.',
      };
    },

    async reconcile() {
      seed();
      await sleep(1100);
      const cost = cents(bets.reduce((n, b) => n + b.cost, 0));
      return { ok: true, checkedAt: new Date().toISOString(), orders: { checked: bets.length * 2, matched: bets.length * 2, missing: 0 }, cash: { ledger: cost, gemini: cost, difference: 0 }, betsNeedingReview: [] };
    },

    async commitCall(betId) {
      seed();
      await sleep(1100);
      const existing = calls.find((c) => c.betId === betId);
      if (existing) return existing;
      const call: CallRecord = { id: `call-${hex(3)}`, handle: 'you', betId, state: 'committed', commitHash: hex(32), commitSignature: fakeSignature(), committedAt: new Date().toISOString() };
      calls.push(call);
      return call;
    },

    async revealCall(callId) {
      seed();
      await sleep(1200);
      const call = calls.find((c) => c.id === callId);
      const bet = call && bets.find((b) => b.id === call.betId);
      if (!call || !bet) throw new ApiError(404, { error: 'No such call.', code: 'not_found' }, 'missing');
      if (!bet.settlement) throw new ApiError(409, { error: 'This bet has not settled yet, so there is nothing to reveal.', code: 'not_settled' }, 'open');
      if (bet.settlement.conditionResolved === 'no') throw new ApiError(409, { error: 'The condition failed, so this call was refunded and does not count.', code: 'void_call' }, 'void');
      const fair = bet.offer?.fairPrice ?? 0.5;
      const o = bet.settlement.targetResolved === 'yes' ? 1 : 0;
      call.state = 'revealed';
      call.reveal = { signature: fakeSignature(), revealedAt: new Date().toISOString(), eventTitle: bet.eventTitle, conditionLabel: bet.condition.label, targetLabel: bet.target.label, fairPriceAtEntry: fair, outcome: o, edge: cents(o - fair) };
      return call;
    },

    async calls() {
      seed();
      await sleep(80);
      return { calls: [...calls].reverse() };
    },

    async leaderboard(): Promise<LeaderboardResponse> {
      seed();
      await sleep(150);
      const others = [
        { calls: 9, edge: 2.41, hitRate: 0.67 },
        { calls: 6, edge: 1.77, hitRate: 0.67 },
        { calls: 11, edge: 1.12, hitRate: 0.55 },
        { calls: 4, edge: 0.58, hitRate: 0.5 },
        { calls: 7, edge: -0.34, hitRate: 0.43 },
      ].map((r, i) => ({ ...r, handle: handleFor(i), lastRevealedAt: new Date(startedAt - (i + 1) * 5400_000).toISOString() }));
      const mine = calls.filter((c) => c.state === 'revealed' && c.reveal);
      const rows = [...others];
      if (mine.length >= 1) {
        rows.push({
          handle: 'you',
          calls: mine.length,
          edge: cents(mine.reduce((n, c) => n + (c.reveal?.edge ?? 0), 0)),
          hitRate: mine.filter((c) => c.reveal?.outcome === 1).length / mine.length,
          lastRevealedAt: mine[mine.length - 1]!.reveal!.revealedAt,
        });
      }
      rows.sort((x, y) => y.edge - x.edge);
      return { asOf: new Date().toISOString(), minCalls: 1, source: 'quicknode-stream', rows: rows.map((r, i) => ({ rank: i + 1, ...r })) };
    },
  };
}
