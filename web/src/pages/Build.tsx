import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CallRecord, MarketEvent, QuoteResponse, Rung } from '../api/types';
import { explorerTx } from '../api/types';
import LadderChart from '../components/LadderChart';
import ProbBar from '../components/ProbBar';
import { cents, money, pct, timeLeft, trunc, usd, usdSigned } from '../lib/format';
import { useAsync, useDebounced, useNow } from '../lib/hooks';
import { estimate, outcomesFor } from '../lib/pricing';
import { useVenue } from '../lib/venue';

const PRESETS = [5, 10, 25, 50];
const shortTitle = (t: string) => t.replace(/ price today at /, ' · ').replace(/ price on /, ' · ');

/** A sensible starting pair: a condition that is likely (so the refund is real) and a target with a fair chance. */
function defaultPair(ev: MarketEvent): { c: string; t: string } | null {
  const ok = ev.pairs.filter((p) => p.quote.offerable && p.quote.chanceBothHappen !== null);
  if (ok.length === 0) {
    const r = [...ev.rungs].sort((a, b) => a.strike - b.strike);
    return r.length >= 2 ? { c: r[0]!.symbol, t: r[1]!.symbol } : null;
  }
  const score = (p: (typeof ok)[number]) => Math.abs((p.quote.chanceCondition ?? 0) - 0.74) + Math.abs((p.quote.chanceBothHappen ?? 0) - 0.36);
  ok.sort((a, b) => score(a) - score(b));
  const best = ok[0]!;
  return { c: best.condition.symbol, t: best.target.symbol };
}

function friendly(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'offer_refused':
      case 'markup_too_high':
      case 'price_too_high':
      case 'no_price':
        return 'This pair is not good value right now. Try a closer target.';
      case 'no_depth':
      case 'insufficient_depth':
        return 'There is not enough on the market to fill that bet. Try a smaller stake.';
      case 'market_closed':
        return 'This market has closed. Pick the next one.';
      case 'price_above_limit':
        return 'The price moved against you before the order went through. Nothing was bought, try again.';
      case 'stake_too_small':
        return 'That stake is too small to place.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export default function Build() {
  const venue = useVenue();
  const now = useNow(20000);
  const markets = useAsync(() => api.markets(), [], 4000);
  // Real exchanges list dozens of ladders. Put the ones you can actually bet on first, and drop one-rung ladders.
  const events = useMemo(() => {
    const usable = (e: MarketEvent) => (e.offerableCount > 0 && !e.ladderOutOfOrder ? 0 : !e.ladderOutOfOrder ? 1 : 2);
    return (markets.data?.events ?? []).filter((e) => e.rungs.length >= 2).map((e, i) => ({ e, i })).sort((a, b) => usable(a.e) - usable(b.e) || a.i - b.i).map((x) => x.e);
  }, [markets.data]);

  const [ticker, setTicker] = useState<string | null>(null);
  const [sel, setSel] = useState<{ c: string; t: string } | null>(null);
  const [stake, setStake] = useState(10);
  const [stakeText, setStakeText] = useState('10');

  const event: MarketEvent | undefined = events.find((e) => e.ticker === ticker) ?? events[0];

  // Start on the first event with a good default pair; reset when the hour rolls over and symbols disappear.
  useEffect(() => {
    if (!event) return;
    if (ticker !== event.ticker) setTicker(event.ticker);
    const valid = sel && event.rungs.some((r) => r.symbol === sel.c) && event.rungs.some((r) => r.symbol === sel.t);
    if (!valid) setSel(defaultPair(event));
  }, [event, sel, ticker]);

  const rungOf = (sym?: string): Rung | undefined => event?.rungs.find((r) => r.symbol === sym);
  const cRung = rungOf(sel?.c);
  const tRung = rungOf(sel?.t);

  // Instant estimate while dragging; the executor's quote replaces it when it arrives.
  const feeCoef = markets.data?.feeCoefCharged ?? 0;
  const est = useMemo(
    () => (cRung && tRung ? estimate({ bid: cRung.bid, ask: cRung.ask }, { bid: tRung.bid, ask: tRung.ask }, feeCoef) : null),
    [cRung, tRung, feeCoef],
  );

  const dStake = useDebounced(stake, 350);
  const dSel = useDebounced(sel, 200);
  const quoteQ = useAsync<QuoteResponse | null>(
    () => (event && dSel ? api.quote({ event: event.ticker, condition: dSel.c, target: dSel.t, stake: dStake }) : Promise.resolve(null)),
    [event?.ticker, dSel?.c, dSel?.t, dStake],
    5000,
  );
  const server = quoteQ.data && sel && quoteQ.data.condition.symbol === sel.c && quoteQ.data.target.symbol === sel.t ? quoteQ.data : null;
  const settling = !server; // showing the estimate

  const offer = server?.quote;
  const chanceCondition = offer?.chanceCondition ?? est?.chanceCondition ?? null;
  const chanceBoth = offer?.chanceBothHappen ?? est?.chanceBothHappen ?? null;
  const fair = offer?.fairPrice ?? est?.fairPrice ?? null;
  const allIn = offer?.allInPrice ?? est?.allIn ?? null;
  const pricePaid = offer?.pricePaid ?? est?.pricePaid ?? null;
  const cashOut100 = offer?.cashOutPer100 ?? est?.cashOutPer100 ?? null;
  const verdict = offer?.verdict ?? est?.verdict ?? null;
  const refusal = offer && !offer.offerable ? offer.reasons[0]?.message ?? 'This pair is not on offer.' : est?.refusal ?? null;
  const offerable = offer ? offer.offerable : est ? est.verdict !== 'refuse' : false;

  const plan = server?.stake;
  const depth = server?.depth && 'maxStake' in server.depth ? server.depth : null;
  const out = plan
    ? { win: plan.ifBothHit, back: plan.ifConditionFails, lose: plan.ifConditionOnly, cost: plan.cost }
    : pricePaid
      ? (() => {
          const o = outcomesFor(stake, pricePaid);
          return { win: o.ifBothHit, back: o.ifConditionFails, lose: o.ifConditionOnly, cost: o.cost };
        })()
      : null;
  const feeNote = allIn !== null && pricePaid !== null && allIn - pricePaid >= 0.01 ? Math.round((allIn - pricePaid) * 100) : null;

  // ------------------------------------------------------------------ place flow
  const [phase, setPhase] = useState<'idle' | 'placing' | 'placed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bet, setBet] = useState<Bet | null>(null);
  const [call, setCall] = useState<CallRecord | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  // A message about one pair must not outlive a change of pair or stake.
  useEffect(() => {
    setError(null);
  }, [sel?.c, sel?.t, stake]);

  const canPlace = !!event && !!sel && offerable && stake >= 1 && phase === 'idle' && !!out && !venue.readOnly;

  async function place() {
    if (!event || !sel) return;
    setPhase('placing');
    setError(null);
    setCallError(null);
    try {
      const res = await api.placeBet({ user: 'primary', event: event.ticker, condition: sel.c, target: sel.t, stake });
      setBet(res.bet);
      setPhase('placed');
      api.commitCall(res.bet.id).then(setCall, (e) => setCallError(friendly(e)));
    } catch (e) {
      setError(friendly(e));
      setPhase('idle');
    }
  }

  function again() {
    setPhase('idle');
    setBet(null);
    setCall(null);
    setError(null);
  }

  const setStakeFrom = (txt: string) => {
    setStakeText(txt);
    const n = Number(txt);
    if (Number.isFinite(n) && n > 0) setStake(Math.min(n, 100000));
  };

  const closing = timeLeft(event?.expiry ?? null, now);
  const loadingFirst = markets.loading && !markets.data;

  return (
    <div className="page build">
      <header className="page-head">
        <div>
          <h1 className="h-page">Build your bet</h1>
          <p className="lede">Choose what has to happen first, then what you are betting on. If the first part fails, you get your money back.</p>
        </div>
      </header>

      {markets.error && !markets.data && (
        <div className="card notice" role="alert">
          <b>We could not load the markets.</b>
          <span>{markets.error.message}</span>
          <button className="btn btn-ghost" onClick={markets.reload}>
            Try again
          </button>
        </div>
      )}

      <div className="build-grid">
        <div className="left-col">
        <section className="card chart-card" aria-busy={loadingFirst}>
          <div className="chart-head">
            <div className="seg" role="tablist" aria-label="Market">
              {events.map((e) => (
                <button
                  key={e.ticker}
                  role="tab"
                  aria-selected={e.ticker === event?.ticker}
                  className={e.ticker === event?.ticker ? 'is-on' : ''}
                  onClick={() => {
                    setTicker(e.ticker);
                    setSel(defaultPair(e));
                    again();
                  }}
                >
                  {shortTitle(e.title)}
                </button>
              ))}
            </div>
            {closing && <span className="chip chip-quiet">{closing}</span>}
          </div>
          <p className="chart-hint">Chance of finishing at or above each price. Drag the two markers, or tap the chart.</p>
          {loadingFirst ? (
            <div className="skeleton chart-skel" />
          ) : event && sel ? (
            <LadderChart rungs={event.rungs} condition={sel.c} target={sel.t} onChange={(c, t) => setSel({ c, t })} />
          ) : (
            <div className="empty">No ladders are open right now. Check back in a few minutes.</div>
          )}
          <div className="chart-foot">
            <span>
              <i className="lg lg-curve" /> Market chance
            </span>
            <span>
              <i className="lg lg-band" /> Buy and sell prices
            </span>
            <span>
              <i className="lg lg-win" /> Your bet
            </span>
          </div>
        </section>

        <section className="card payoff" aria-label="How this bet pays">
          <h2 className="h-card">How this bet pays</h2>
          <div className="payoff-grid">
            <div data-kind="win">
              <span className="po-chance">{chanceBoth !== null ? `${pct(chanceBoth)} chance` : '–'}</span>
              <b>{out ? usdSigned(out.win) : '–'}</b>
              <p>It reaches {tRung ? money(tRung.strike) : '…'}</p>
            </div>
            <div data-kind="back">
              <span className="po-chance">{chanceCondition !== null ? `${pct(1 - chanceCondition)} chance` : '–'}</span>
              <b>{out ? 'Stake back' : '–'}</b>
              <p>It falls below {cRung ? money(cRung.strike) : '…'}</p>
            </div>
            <div data-kind="lose">
              <span className="po-chance">{chanceCondition !== null && chanceBoth !== null ? `${pct(chanceCondition - chanceBoth)} chance` : '–'}</span>
              <b>{out ? usdSigned(out.lose) : '–'}</b>
              <p>It holds {cRung ? money(cRung.strike) : '…'} but stops short</p>
            </div>
          </div>
        </section>
        </div>

        <aside className="card quote-card" aria-live="polite">
          {phase === 'placed' && bet ? (
            <Receipt bet={bet} call={call} callError={callError} onAgain={again} />
          ) : (
            <>
              <div className="q-title">
                <span className="eyebrow">{event ? shortTitle(event.title) : 'Loading'}</span>
                <h2 className="q-sentence">
                  Given <em>{cRung ? money(cRung.strike) : '…'}</em> or above, will it reach <em>{tRung ? money(tRung.strike) : '…'}</em>?
                </h2>
              </div>

              {chanceCondition !== null && chanceBoth !== null ? (
                <ProbBar chanceCondition={chanceCondition} chanceBoth={chanceBoth} />
              ) : (
                <div className="skeleton bar-skel" />
              )}

              <dl className={`nums ${settling ? 'is-est' : ''}`}>
                <div>
                  <dt>Chance both happen</dt>
                  <dd>{chanceBoth !== null ? pct(chanceBoth) : '–'}</dd>
                </div>
                <div>
                  <dt>Fair price per $1</dt>
                  <dd>{fair !== null ? cents(fair) : '–'}</dd>
                </div>
                <div>
                  <dt>You pay per $1</dt>
                  <dd className={verdict === 'warn' ? 'warn' : ''}>{pricePaid !== null ? cents(pricePaid) : '–'}</dd>
                </div>
                <div>
                  <dt>Sell back now, per $100</dt>
                  <dd>{cashOut100 !== null ? usd(cashOut100, 0) : '–'}</dd>
                </div>
              </dl>

              {verdict === 'warn' && !refusal && <p className="note note-warn">Costs a little more than fair value. You can see exactly how much above.</p>}
              {!offerable && (offer || est) && (
                <p className="note note-bad" role="alert">
                  {refusal ?? 'This pair is not on offer right now.'}
                  {/out of order/i.test(refusal ?? '') ? '' : ' Try moving the target closer.'}
                </p>
              )}

              <div className="stake">
                <label htmlFor="stake">Stake</label>
                <div className="stake-row">
                  <div className="field">
                    <span className="field-pre">$</span>
                    <input
                      id="stake"
                      inputMode="decimal"
                      value={stakeText}
                      onChange={(e) => setStakeFrom(e.target.value.replace(/[^\d.]/g, ''))}
                      aria-describedby="stake-note"
                    />
                  </div>
                  <div className="presets">
                    {PRESETS.map((p) => (
                      <button key={p} className={`chip ${stake === p ? 'is-on' : ''}`} onClick={() => setStakeFrom(String(p))}>
                        ${p}
                      </button>
                    ))}
                  </div>
                </div>
                <p id="stake-note" className="fine">
                  {plan?.reduced
                    ? `The market can only fill about ${usd(plan.cost)} at this price, so the bet will be that size.`
                    : depth
                      ? `Up to ${usd(depth.maxStake, 0)} fits right now.`
                      : 'The two orders are sized so your stake comes back if the first part fails.'}
                </p>
              </div>

              {error && offerable && (
                <p className="note note-bad" role="alert">
                  {error}
                </p>
              )}

              <button className="btn btn-primary btn-wide" disabled={!canPlace} onClick={place}>
                {phase === 'placing' ? (
                  <>
                    <span className="spin" aria-hidden="true" /> Placing both orders
                  </>
                ) : venue.readOnly ? (
                  'Bets are switched off'
                ) : !offerable ? (
                  'Pick a closer target'
                ) : (
                  `Place bet · ${usd(plan?.cost ?? stake)}`
                )}
              </button>
              <p className="fine center">
                {venue.footnote}
                {feeNote ? ` Real fees would add about ${feeNote}¢ per $1.` : ''}
              </p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ receipt

function Receipt({ bet, call, callError, onAgain }: { bet: Bet; call: CallRecord | null; callError: string | null; onAgain: () => void }) {
  const [out, hedge] = [bet.legs.find((l) => l.role === 'outcome'), bet.legs.find((l) => l.role === 'hedge')];
  return (
    <div className="receipt">
      <div className="q-title">
        <span className="eyebrow">Bet placed</span>
        <h2 className="q-sentence">
          {usd(bet.cost)} on <em>{money(bet.target.strike)}</em>, given <em>{money(bet.condition.strike)}</em>
        </h2>
      </div>

      <ol className="steps">
        <li className="is-done">
          <span className="dot" />
          <div>
            <b>Order 1 filled</b>
            <p>
              {out?.quantityFilled} contracts at {out?.avgPrice !== null && out?.avgPrice !== undefined ? cents(out.avgPrice) : '–'} that it reaches {money(bet.target.strike)}
            </p>
            {out?.orderId && <code className="mono-chip">Order {trunc(out.orderId, 6, 4)}</code>}
          </div>
        </li>
        <li className="is-done">
          <span className="dot" />
          <div>
            <b>Order 2 filled</b>
            <p>
              {hedge?.quantityFilled} contracts at {hedge?.avgPrice !== null && hedge?.avgPrice !== undefined ? cents(hedge.avgPrice) : '–'} that it falls below {money(bet.condition.strike)}. This is what returns your stake.
            </p>
            {hedge?.orderId && <code className="mono-chip">Order {trunc(hedge.orderId, 6, 4)}</code>}
          </div>
        </li>
        <li className={call ? 'is-done' : callError ? 'is-fail' : 'is-active'}>
          <span className="dot" />
          <div>
            <b>{call ? 'Call recorded on Solana' : callError ? 'Could not record the call' : 'Recording your call on Solana'}</b>
            <p>{callError ?? 'A fingerprint of this call, not the details, so you can prove later that you made it first.'}</p>
            {call &&
              (call.network === 'devnet' ? (
                <a className="mono-chip link" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
                  {trunc(call.commitSignature, 8, 6)} ↗
                </a>
              ) : (
                <code className="mono-chip">{trunc(call.commitSignature, 8, 6)} · test chain</code>
              ))}
          </div>
        </li>
      </ol>

      <ul className="outcomes">
        <li data-kind="win">
          <span>If it reaches {money(bet.target.strike)}</span>
          <b>{usdSigned(bet.payoffs?.ifBothHit ?? 0)}</b>
        </li>
        <li data-kind="back">
          <span>If it falls below {money(bet.condition.strike)}</span>
          <b>Stake back</b>
        </li>
      </ul>

      <div className="row-actions">
        <Link className="btn btn-primary" to="/app/bets">
          See my bets
        </Link>
        <button className="btn btn-ghost" onClick={onAgain}>
          Make another
        </button>
      </div>
    </div>
  );
}
