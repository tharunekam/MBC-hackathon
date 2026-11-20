import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Bet, CallRecord, MarketEvent, RangeQuoteResponse, Rung } from '../api/types';
import DistCard from '../components/DistCard';
import LadderChart from '../components/LadderChart';
import MarketPicker from '../components/MarketPicker';
import RangeBar from '../components/RangeBar';
import Receipt from '../components/Receipt';
import StakeField from '../components/StakeField';
import { MIN_BET, rangeButtonState } from '../lib/betState';
import { defaultRange } from '../lib/defaultRange';
import { cents, money, pct, usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useDebounced, useNow, useResource } from '../lib/hooks';
import { listLadders, shortTitle } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { rangeEstimate, rangeOutcomesFor } from '../lib/pricing';
import { receiptWords } from '../lib/receiptWords';
import { useVenue } from '../lib/venue';
import '../styles/builder.css';
import '../styles/range.css';

type Sel = { low: string; high: string };

/**
 * Where a ladder starts: the default range from its open prices; on a ladder that is not open yet, the same choice from the
 * prices it shows, so the button can say why it cannot be placed; and on a ladder with almost no prices, its middle two rungs.
 */
function startOn(ev: MarketEvent, feeCoef: number): Sel | null {
  const pick = defaultRange(ev, { feeCoef }) ?? defaultRange(ev, { feeCoef, openOnly: false });
  if (pick) return pick;
  const r = [...ev.rungs].sort((a, b) => a.strike - b.strike);
  if (r.length < 2) return null;
  const i = Math.max(0, Math.floor(r.length / 2) - 1);
  return { low: r[i]!.symbol, high: r[i + 1]!.symbol };
}

export default function Range() {
  const venue = useVenue();
  const now = useNow(20000);
  const markets = useResource('markets', () => api.markets(), { live: [[execLive, 'markets']], pollMs: 4000, minGapMs: 800 });
  const [showUnpriced, setShowUnpriced] = useState(false);
  const ladders = useMemo(() => listLadders(markets.data?.events ?? [], showUnpriced), [markets.data, showUnpriced]);
  const events = ladders.shown;
  const feeCoef = markets.data?.feeCoefCharged ?? 0;

  // The Markets page links here with ?market=TICKER; a ladder with no prices is listed when that is the one asked for.
  const [params] = useSearchParams();
  const wanted = params.get('market');
  const [ticker, setTicker] = useState<string | null>(wanted);
  useEffect(() => {
    if (wanted && !showUnpriced && ladders.unpriced.some((e) => e.ticker === wanted)) setShowUnpriced(true);
  }, [wanted, showUnpriced, ladders.unpriced]);

  // The Hunch page links here with a range already chosen (?low=&high=); one the ladder no longer has falls back to the default.
  const [sel, setSel] = useState<Sel | null>(() => {
    const [low, high] = [params.get('low'), params.get('high')];
    return low && high ? { low, high } : null;
  });
  const [stake, setStake] = useState(10);
  const [stakeText, setStakeText] = useState('10');

  const event: MarketEvent | undefined = events.find((e) => e.ticker === ticker) ?? ladders.first;

  // Start on a sensible range; start again when prices refresh and a chosen level is gone or the two are out of order.
  useEffect(() => {
    if (!event) return;
    if (ticker !== event.ticker) setTicker(event.ticker);
    const lo = sel && event.rungs.find((r) => r.symbol === sel.low);
    const hi = sel && event.rungs.find((r) => r.symbol === sel.high);
    if (!lo || !hi || !(lo.strike < hi.strike)) setSel(startOn(event, feeCoef));
  }, [event, sel, ticker, feeCoef]);

  const rungOf = (sym?: string): Rung | undefined => event?.rungs.find((r) => r.symbol === sym);
  const lowRung = rungOf(sel?.low);
  const highRung = rungOf(sel?.high);

  // Instant estimate while dragging; the executor's quote replaces it when it arrives.
  const est = useMemo(() => {
    if (!lowRung || !highRung) return null;
    return rangeEstimate({ bid: lowRung.bid, ask: lowRung.ask }, { bid: highRung.bid, ask: highRung.ask }, feeCoef);
  }, [lowRung, highRung, feeCoef]);

  const dStake = useDebounced(stake, 350);
  // What to ask the executor, debounced as one snapshot of ladder and levels: choosing another ladder then never sends the old
  // levels to it. Empty until the two levels are in order.
  const asked = event && sel && lowRung && highRung && lowRung.strike < highRung.strike ? `${event.ticker}|${sel.low}|${sel.high}` : '';
  const dAsked = useDebounced(asked, 200);
  const [dTicker, dLow, dHigh] = dAsked.split('|') as [string, string, string];
  const quoteQ = useResource<RangeQuoteResponse | null>(
    `range:${dAsked}:${dStake}`,
    () => (dAsked ? api.quoteRange({ event: dTicker, low: dLow, high: dHigh, stake: dStake }) : Promise.resolve(null)),
    { live: [[execLive, 'markets']], pollMs: 5000, minGapMs: 1500 },
  );
  const server = quoteQ.data && sel && quoteQ.data.low.symbol === sel.low && quoteQ.data.high.symbol === sel.high ? quoteQ.data : null;
  // The button may rely on the executor's answer only when it is for this range AND this stake, not one a moment ago.
  const current = !!server && dAsked === asked && dStake === stake;
  const settling = !server;

  const offer = server?.quote;
  const chanceIn = offer?.chanceInRange ?? est?.chanceInRange ?? null;
  const fair = offer?.fairPrice ?? est?.fairPrice ?? null;
  const pricePaid = offer?.pricePaid ?? est?.pricePaid ?? null;
  const cashOut100 = offer?.cashOutPer100 ?? est?.cashOutPer100 ?? null;
  const verdict = offer?.verdict ?? est?.verdict ?? null;

  // ------------------------------------------------------------------ place flow
  const [phase, setPhase] = useState<'idle' | 'placing' | 'placed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bet, setBet] = useState<Bet | null>(null);
  const [call, setCall] = useState<CallRecord | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const plan = server?.stake;
  const depth = server?.depth && 'maxStake' in server.depth ? server.depth : null;
  const placedBet = phase === 'placed' ? bet : null;
  const out = placedBet?.payoffs
    ? {
        win: placedBet.payoffs.ifInRange ?? placedBet.payoffs.ifBothHit,
        lose: placedBet.payoffs.ifOutside ?? placedBet.payoffs.ifConditionOnly,
        cost: placedBet.cost,
        back: placedBet.legs.length ? Math.min(...placedBet.legs.map((l) => l.quantityFilled)) : 0,
      }
    : plan
      ? plan.cost >= MIN_BET
        ? { win: plan.ifInRange, lose: plan.ifOutside, cost: plan.cost, back: plan.backAlways }
        : null // the market cannot fill a bet of any real size: no figures rather than $0.00s
      : est
        ? (() => {
            const o = rangeOutcomesFor(stake, est.unitCost);
            return { win: o.ifInRange, lose: o.ifOutside, cost: o.cost, back: o.backAlways };
          })()
        : null;

  // A message about one range must not outlive a change of range or stake.
  useEffect(() => {
    setError(null);
  }, [sel?.low, sel?.high, stake]);

  const state = rangeButtonState({
    phase,
    readOnly: venue.readOnly,
    stake,
    low: lowRung,
    high: highRung,
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
      const res = await api.placeBet({ product: 'range', user: 'primary', event: event.ticker, low: sel.low, high: sel.high, stake });
      setBet(res.bet);
      setPhase('placed');
      api.commitCall(res.bet.id).then(setCall, (e) => setCallError(friendly(e)));
    } catch (e) {
      setError(friendly(e, { product: 'range' }));
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

  function pick(e: MarketEvent) {
    setTicker(e.ticker);
    setSel(startOn(e, feeCoef));
    again();
  }

  const setStakeFrom = (txt: string) => {
    setStakeText(txt);
    const n = Number(txt);
    if (Number.isFinite(n) && n > 0) setStake(Math.min(n, 100000));
  };

  const loadingFirst = markets.loading && !markets.data;
  const both = !!lowRung && !!highRung;
  const words = receiptWords({
    product: 'range',
    condition: { symbol: '', label: '', strike: lowRung?.strike ?? 0 },
    target: { symbol: '', label: '', strike: highRung?.strike ?? 0 },
  });
  // The inside chance is rounded once, so inside and outside always add to 100% on screen.
  const insideShown = chanceIn !== null ? Math.round(chanceIn * 100) / 100 : null;
  const chance = { win: insideShown, back: null, lose: insideShown !== null ? Math.round((1 - insideShown) * 100) / 100 : null };
  const amount = (kind: 'win' | 'back' | 'lose') => (!out ? '–' : usdSigned(kind === 'win' ? out.win : out.lose));

  return (
    <div className="page builder range-page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Win if the price finishes between two levels</span>
          <h1 className="h-page">Range</h1>
          <p className="lede">Choose a floor and a ceiling: if the price finishes between them you win, and part of your stake comes back whatever happens.</p>
        </div>
        <Link to={{ pathname: '/', hash: '#how' }} className="head-link">
          How it works
        </Link>
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
            <MarketPicker
              events={events}
              event={event}
              onPick={pick}
              unpriced={ladders.unpriced.length}
              showUnpriced={showUnpriced}
              onToggleUnpriced={() => setShowUnpriced((v) => !v)}
              now={now}
            />
            <p className="chart-hint">
              {phase === 'placed'
                ? 'Your range, on the market’s chance of finishing at or above each price. Choose “Make another” to change it.'
                : 'Chance of finishing at or above each price. Drag the two markers to set the floor and the ceiling, or tap the chart.'}
            </p>
            {loadingFirst ? (
              <div className="skeleton chart-skel" />
            ) : event && sel ? (
              <div className={phase === 'placed' ? 'chart-locked' : undefined}>
                <LadderChart rungs={event.rungs} condition={sel.low} target={sel.high} mode="range" onChange={(low, high) => phase !== 'placed' && setSel({ low, high })} />
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
                <i className="lg lg-win" /> Your range
              </span>
            </div>
          </section>

          <section className="card payoff" aria-label="How this bet pays">
            <header className="card-head">
              <h2 className="h-card">How this bet pays</h2>
              <span className="fine">{out ? `On a ${usd(out.cost)} bet` : 'Per bet'}</span>
            </header>
            <table className="scen">
              <thead>
                <tr>
                  <th scope="col">If</th>
                  <th scope="col" className="n">
                    Chance
                  </th>
                  <th scope="col" className="n">
                    You get
                  </th>
                </tr>
              </thead>
              <tbody>
                {words.outcomes.map((o) => (
                  <tr key={o.kind} data-kind={o.kind}>
                    <td>
                      <i aria-hidden="true" />
                      {both ? o.label : '…'}
                    </td>
                    <td className="n">{chance[o.kind] !== null ? pct(chance[o.kind]!) : '–'}</td>
                    <td className="n">{amount(o.kind)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine rg-always">{out ? `${usd(out.back)} comes back whatever happens.` : 'One of the two orders always pays, so part of the stake comes back whatever happens.'}</p>
          </section>

          {event && lowRung && highRung && <DistCard rungs={event.rungs} shape={{ kind: 'range', low: lowRung.strike, high: highRung.strike }} />}

          {event && (
            <section className="card rungs" aria-label="The ladder">
              <header className="card-head">
                <h2 className="h-card">The ladder</h2>
                <span className="fine">Every price this market lists</span>
              </header>
              <table className="scen">
                <thead>
                  <tr>
                    <th scope="col">Price</th>
                    <th scope="col" className="n">
                      Chance
                    </th>
                    <th scope="col" className="n">
                      Buy
                    </th>
                    <th scope="col" className="n">
                      Sell
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {event.rungs.map((r) => {
                    const mid = r.bid !== null && r.ask !== null ? (r.bid + r.ask) / 2 : null;
                    const inside = both && r.strike > lowRung!.strike && r.strike < highRung!.strike;
                    return (
                      <tr key={r.symbol} className={r.symbol === sel?.low || r.symbol === sel?.high ? 'is-picked' : inside ? 'is-inside' : undefined}>
                        <td>
                          {money(r.strike)}
                          {r.symbol === sel?.low && <span className="tag">Floor</span>}
                          {r.symbol === sel?.high && <span className="tag">Ceiling</span>}
                        </td>
                        <td className="n">{mid !== null ? pct(mid) : '–'}</td>
                        <td className="n">{r.ask !== null ? cents(r.ask) : '–'}</td>
                        <td className="n">{r.bid !== null ? cents(r.bid) : '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
        </div>

        <aside className="card quote-card" aria-live="polite">
          {phase === 'placed' && bet ? (
            <Receipt bet={bet} call={call} callError={callError} onAgain={again} />
          ) : (
            <>
              <div className="q-title">
                <span className="eyebrow">{event ? shortTitle(event.title) : 'Loading'}</span>
                <h2 className="q-sentence">
                  Will it finish between <em>{lowRung ? money(lowRung.strike) : '…'}</em> and <em>{highRung ? money(highRung.strike) : '…'}</em>?
                </h2>
              </div>

              {chanceIn !== null ? <RangeBar chanceInRange={chanceIn} /> : <div className="skeleton bar-skel" />}

              <div className="rg-figures">
                <dl className={`nums ${settling ? 'is-est' : ''}`}>
                  <div>
                    <dt>Chance inside</dt>
                    <dd>{chanceIn !== null ? pct(chanceIn) : '–'}</dd>
                  </div>
                  <div>
                    <dt>Fair price per $1</dt>
                    <dd>{fair !== null && fair < 1 ? cents(fair) : '–'}</dd>
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
                <p className="rg-pay">
                  {out ? (
                    <>
                      You pay <b>{usd(out.cost)}</b> now. At least <b>{usd(out.back)}</b> comes back whatever happens.
                    </>
                  ) : (
                    'One of the two orders always pays, so part of your stake comes back whatever happens.'
                  )}
                </p>
              </div>

              {verdict === 'warn' && !state.notice && fair !== null && pricePaid !== null && (
                <p className="note note-warn">
                  Costs a little more than fair value: {cents(pricePaid)} per $1 against a fair {cents(fair)}.
                </p>
              )}

              <StakeField
                id="stake"
                text={stakeText}
                stake={stake}
                onText={setStakeFrom}
                note={
                  plan?.reduced && state.blockedBy !== 'thin'
                    ? `The market can only fill about ${usd(plan.cost)} at these prices, so the bet will be that size.`
                    : depth && depth.maxStake >= 1
                      ? `Up to ${usd(depth.maxStake, 0)} fits right now.`
                      : 'Both orders are the same size, so one of them always pays.'
                }
              />

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
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
