import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CallRecord, MarketEvent, QuoteResponse, Rung } from '../api/types';
import { explorerTx } from '../api/types';
import LadderChart from '../components/LadderChart';
import ProbBar from '../components/ProbBar';
import { cents, money, pct, timeLeft, trunc, usd, usdSigned } from '../lib/format';
import { useDebounced, useNow, useResource } from '../lib/hooks';
import { execLive } from '../lib/liveClients';
import { MIN_BET, buttonState } from '../lib/betState';
import { defaultPair } from '../lib/defaultPair';
import { listLadders, shortTitle } from '../lib/ladders';
import { estimate, outcomesFor } from '../lib/pricing';
import { useVenue } from '../lib/venue';

const PRESETS = [5, 10, 25, 50];

function friendly(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'offer_refused':
      case 'markup_too_high':
        return 'This pair is not good value right now. Nothing was bought. Try other prices.';
      case 'price_too_high':
      case 'no_price':
        return 'The payout would be too small for the price. Nothing was bought. Move the target further above the condition.';
      case 'no_depth':
        return 'We could not read the market just now, so nothing was bought. Try again in a moment.';
      case 'insufficient_depth':
        return 'There is not enough resting on the market to fill that bet right now. Nothing was bought. Try a smaller stake or other prices.';
      case 'market_closed':
        return 'This market is not open for trading right now. Nothing was bought. Pick other prices or check back shortly.';
      case 'price_above_limit':
        return 'The price moved against you before the order went through. Nothing was bought. Try again.';
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
  const markets = useResource('markets', () => api.markets(), { live: [[execLive, 'markets']], pollMs: 4000, minGapMs: 800 });
  // Real exchanges list dozens of ladders, most with no prices at a given moment. The tabs are the ones with prices, in
  // the exchange's order; the page opens on one you can bet on. The rest are a tap away, never hidden without saying so.
  const [showUnpriced, setShowUnpriced] = useState(false);
  const ladders = useMemo(() => listLadders(markets.data?.events ?? [], showUnpriced), [markets.data, showUnpriced]);
  const events = ladders.shown;

  const [ticker, setTicker] = useState<string | null>(null);
  const [sel, setSel] = useState<{ c: string; t: string } | null>(null);
  const [stake, setStake] = useState(10);
  const [stakeText, setStakeText] = useState('10');

  const event: MarketEvent | undefined = events.find((e) => e.ticker === ticker) ?? ladders.first;

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
  // One cached answer per pair and stake: going back to a pair you looked at is instant, and prices that move refresh it.
  const quoteQ = useResource<QuoteResponse | null>(
    `quote:${event?.ticker}:${dSel?.c}:${dSel?.t}:${dStake}`,
    () => (event && dSel ? api.quote({ event: event.ticker, condition: dSel.c, target: dSel.t, stake: dStake }) : Promise.resolve(null)),
    { live: [[execLive, 'markets']], pollMs: 5000, minGapMs: 1500 },
  );
  const server = quoteQ.data && sel && quoteQ.data.condition.symbol === sel.c && quoteQ.data.target.symbol === sel.t ? quoteQ.data : null;
  // The button may rely on the executor's answer only when it is for this pair AND this stake, not one a moment ago.
  const current = !!server && dSel?.c === sel?.c && dSel?.t === sel?.t && dStake === stake;
  const settling = !server; // showing the estimate

  const offer = server?.quote;
  const chanceCondition = offer?.chanceCondition ?? est?.chanceCondition ?? null;
  const chanceBoth = offer?.chanceBothHappen ?? est?.chanceBothHappen ?? null;
  const fair = offer?.fairPrice ?? est?.fairPrice ?? null;
  const allIn = offer?.allInPrice ?? est?.allIn ?? null;
  const pricePaid = offer?.pricePaid ?? est?.pricePaid ?? null;
  const cashOut100 = offer?.cashOutPer100 ?? est?.cashOutPer100 ?? null;
  const verdict = offer?.verdict ?? est?.verdict ?? null;
  // A "fair price" above $1 means the two prices are out of step; it is not a number to show.
  const fairShown = fair !== null && fair < 1 ? fair : null;

  // ------------------------------------------------------------------ place flow
  const [phase, setPhase] = useState<'idle' | 'placing' | 'placed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bet, setBet] = useState<Bet | null>(null);
  const [call, setCall] = useState<CallRecord | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const plan = server?.stake;
  const depth = server?.depth && 'maxStake' in server.depth ? server.depth : null;
  // Once a bet is placed the panel shows that bet's figures, which may be smaller than the stake that was asked for.
  const placedBet = phase === 'placed' ? bet : null;
  const out = placedBet?.payoffs
    ? { win: placedBet.payoffs.ifBothHit, back: placedBet.payoffs.ifConditionFails, lose: placedBet.payoffs.ifConditionOnly, cost: placedBet.cost }
    : plan
    ? plan.cost >= MIN_BET
      ? { win: plan.ifBothHit, back: plan.ifConditionFails, lose: plan.ifConditionOnly, cost: plan.cost }
      : null // the market cannot fill a bet of any real size: no figures rather than $0.00s
    : pricePaid
      ? (() => {
          const o = outcomesFor(stake, pricePaid);
          return { win: o.ifBothHit, back: o.ifConditionFails, lose: o.ifConditionOnly, cost: o.cost };
        })()
      : null;
  const feeNote = allIn !== null && pricePaid !== null && allIn - pricePaid >= 0.01 ? Math.round((allIn - pricePaid) * 100) : null;

  // A message about one pair must not outlive a change of pair or stake.
  useEffect(() => {
    setError(null);
  }, [sel?.c, sel?.t, stake]);

  const state = buttonState({
    phase,
    readOnly: venue.readOnly,
    stake,
    condition: cRung,
    target: tRung,
    answer: current ? server : null,
    answerError: !!quoteQ.error && !quoteQ.data,
    est,
  });
  const canPlace = state.canPlace && !!event && !!sel;

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
      quoteQ.reload(); // the market has moved on from the answer the button was built on
      markets.reload();
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

  // Keep the chosen tab in view inside the strip. Only the strip moves, never the page.
  const tabsRef = useRef<HTMLDivElement>(null);
  const shownTicker = event?.ticker;
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left - 4;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 4;
  }, [shownTicker, events.length]);
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
            <div className="seg" role="tablist" aria-label="Market" ref={tabsRef}>
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
          {ladders.unpriced.length > 0 && (
            <button type="button" className="more-markets" aria-expanded={showUnpriced} onClick={() => setShowUnpriced((v) => !v)}>
              {showUnpriced
                ? 'Hide markets with no prices'
                : `${ladders.unpriced.length} more ${ladders.unpriced.length === 1 ? 'market has' : 'markets have'} no prices right now. Show ${ladders.unpriced.length === 1 ? 'it' : 'them'}`}
            </button>
          )}
          <p className="chart-hint">
            {phase === 'placed' ? 'Your bet, on the market’s chance of finishing at or above each price. Choose “Make another” to change it.' : 'Chance of finishing at or above each price. Drag the two markers, or tap the chart.'}
          </p>
          {loadingFirst ? (
            <div className="skeleton chart-skel" />
          ) : event && sel ? (
            // Once the bet is placed the markers show that bet and stay put; "Make another" frees them again.
            <div className={phase === 'placed' ? 'chart-locked' : undefined}>
              <LadderChart rungs={event.rungs} condition={sel.c} target={sel.t} onChange={(c, t) => phase !== 'placed' && setSel({ c, t })} />
            </div>
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
                  <dd>{fairShown !== null ? cents(fairShown) : '–'}</dd>
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

              {verdict === 'warn' && !state.notice && <p className="note note-warn">Costs a little more than fair value. You can see exactly how much above.</p>}

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
                  {plan?.reduced && state.blockedBy !== 'thin'
                    ? `The market can only fill about ${usd(plan.cost)} at this price, so the bet will be that size.`
                    : depth && depth.maxStake >= 1
                      ? `Up to ${usd(depth.maxStake, 0)} fits right now.`
                      : 'The two orders are sized so your stake comes back if the first part fails.'}
                </p>
              </div>

              {error && (
                <p className="note note-bad" role="alert">
                  {error}
                </p>
              )}
              {state.notice && !error && (
                <p className={`note note-${state.notice.tone}`} role={state.notice.tone === 'bad' ? 'alert' : undefined}>
                  {state.notice.text}
                </p>
              )}

              <button className="btn btn-primary btn-wide" disabled={!canPlace} onClick={place}>
                {phase === 'placing' ? <span className="spin" aria-hidden="true" /> : null}
                {state.label}
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

      {bet.stakeReduced && (
        <p className="note note-info">
          Only part of your {usd(bet.stakeReduced.requested)} stake was on the market at this price, so the bet is {usd(bet.cost)}. The figures below are for that size.
        </p>
      )}

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
        <li data-kind="lose">
          <span>If it holds {money(bet.condition.strike)} but stops short</span>
          <b>{usdSigned(bet.payoffs?.ifConditionOnly ?? -bet.cost)}</b>
        </li>
      </ul>

      <p className="fine next-step">
        {timeLeft(bet.expiry) ?? 'The market closes soon'}. The result appears on My bets by itself, and you do not need to keep this page open.
      </p>

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
