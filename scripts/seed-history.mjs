#!/usr/bin/env node
/**
 * Fills the app with a believable history for demos and screenshots, through the real APIs.
 *
 *   node scripts/seed-history.mjs place [--spot N] [--event TICKER]   place a win-bound, a refund-bound and a loss-bound bet, commit each call
 *   node scripts/seed-history.mjs finish             settle, then reveal every call that can be revealed
 *   node scripts/seed-history.mjs all                place, settle the local test exchange at the chosen price, finish
 *
 * It only uses pairs the offer rule actually accepts, and picks the price at which one bet wins, one is refunded (the
 * first half fails) and one loses. A loss is kept on purpose: a history with no losses is not believable.
 *
 * On the local test exchange (`npm run dev`) `all` runs end to end in seconds. On Gemini's sandbox hourly markets settle on
 * their own at the top of the hour, so run `place` now (pass --spot with the current price if you know it; otherwise it is
 * estimated from the ladder) and `finish` after expiry. Which bet wins then depends on where the price really ends up.
 */
const WEB = process.env.GIVEN_WEB ?? 'http://127.0.0.1:5273';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function call(path, init) {
  const res = await fetch(`${WEB}${path}`, { ...init, headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${body?.error ?? text.slice(0, 120)}`);
  return body;
}

/** The strike where the market's own chance crosses 50%: the best guess of the current price. */
function estimateSpot(rungs) {
  const pts = rungs.filter((r) => r.bid !== null && r.ask !== null).map((r) => ({ k: r.strike, p: (r.bid + r.ask) / 2 })).sort((a, b) => a.k - b.k);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    if (a.p >= 0.5 && b.p <= 0.5) return a.k + ((a.p - 0.5) / (a.p - b.p || 1)) * (b.k - a.k);
  }
  return pts[Math.floor(pts.length / 2)]?.k ?? 0;
}

/** Prices span $0.90 (XRP) to $64,000 (BTC), so keep enough digits to tell neighbouring strikes apart. */
const price = (n) => (Math.abs(n) >= 100 ? String(Math.round(n)) : Number(n.toFixed(3)).toString());

const classOf = (pair, spot) => (pair.condition.strike > spot ? 'refund' : pair.target.strike <= spot ? 'win' : 'loss');
const cost = (pair) => pair.quote.markup ?? 1;

/** Chooses one offerable pair per outcome, at the price (a midpoint between strikes) closest to the estimate that yields all three. */
function plan(ev, hint) {
  const offerable = ev.pairs.filter((p) => p.quote.offerable);
  const ks = ev.rungs.map((r) => r.strike).sort((a, b) => a - b);
  const candidates = ks.slice(0, -1).map((k, i) => (k + ks[i + 1]) / 2).sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
  for (const spot of candidates) {
    const best = {};
    for (const p of offerable) {
      const c = classOf(p, spot);
      if (!best[c] || cost(p) < cost(best[c])) best[c] = p;
    }
    if (best.win && best.loss && best.refund) return { spot, picks: [['win', 25, best.win], ['loss', 15, best.loss], ['refund', 25, best.refund]] };
  }
  return null;
}

async function place() {
  const { events } = await call('/api/markets');
  // Try every ladder that has offers, fullest first. On Gemini's sandbox the first one listed is often a ladder with two
  // or three offerable pairs (or one that has just gone post-only), which cannot give all three outcomes.
  const withOffers = events.filter((e) => e.offerableCount > 0).sort((a, b) => b.offerableCount - a.offerableCount);
  if (withOffers.length === 0) throw new Error('No offerable ladder right now.');
  const only = arg('event');
  const given = arg('spot');
  const tried = [];
  let ev = null;
  let hint = 0;
  let chosen = null;
  for (const e of withOffers) {
    if (only && e.ticker !== only) continue;
    hint = given !== undefined ? Number(given) : estimateSpot(e.rungs);
    chosen = plan(e, hint);
    if (chosen) {
      ev = e;
      break;
    }
    tried.push(`${e.ticker} (${e.offerableCount} offerable, price about ${price(hint)})`);
  }
  if (!ev || !chosen) {
    throw new Error(`No ladder has offerable pairs that give a win, a loss and a refund. Tried: ${tried.join('; ') || 'none'}. Try again when the books are tighter.`);
  }
  console.log(`ladder ${ev.ticker}, estimated price ${price(hint)}, planned settlement ${price(chosen.spot)}`);
  for (const [kind, stake, pair] of chosen.picks) {
    const { bet } = await call('/api/bets', { method: 'POST', body: JSON.stringify({ user: 'primary', event: ev.ticker, condition: pair.condition.symbol, target: pair.target.symbol, stake }) });
    const rec = await call('/chain/calls', { method: 'POST', body: JSON.stringify({ betId: bet.id }) });
    console.log(`placed ${kind.padEnd(6)} ${bet.id}  $${bet.cost.toFixed(2)}  ${pair.condition.strike} -> ${pair.target.strike}  call ${rec.id}`);
  }
  return chosen.spot;
}

async function finish() {
  const s = await call('/api/settle', { method: 'POST' });
  console.log(`settled ${s.settled.length}, still open ${s.stillOpen}`);
  const { calls } = await call('/chain/calls');
  for (const c of calls.filter((x) => x.state === 'committed')) {
    try {
      const r = await call(`/chain/calls/${c.id}/reveal`, { method: 'POST' });
      console.log(`revealed ${c.id}  edge ${r.reveal.edge >= 0 ? '+' : ''}${r.reveal.edge}  /verify/${r.reveal.signature.slice(0, 10)}…`);
    } catch (e) {
      console.log(`not revealed ${c.id}: ${e.message.replace(/^.*-> \d+ /, '')}`);
    }
  }
}

async function resolveLocal(spot) {
  const r = await fetch(`${WEB}/api/dev/resolve?spot=${spot}`, { method: 'POST' });
  if (!r.ok) throw new Error('This is not the local test exchange (no /dev/resolve). On Gemini, wait for expiry and run `finish`.');
  console.log(`test exchange settled at ${spot}`);
}

const mode = process.argv[2];
try {
  if (mode === 'place') await place();
  else if (mode === 'finish') await finish();
  else if (mode === 'all') {
    const spot = await place();
    await resolveLocal(spot);
    await finish();
  } else {
    console.error('Usage: node scripts/seed-history.mjs place [--spot N] | finish | all');
    process.exit(1);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
