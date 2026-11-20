import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Bet, BreakoutQuoteResponse, CallRecord, MarketEvent, RangeQuoteResponse, Rung } from '../api/types';
import DistCard from '../components/DistCard';
import LadderChart from '../components/LadderChart';
import LadderTable from '../components/LadderTable';
import MarketPicker from '../components/MarketPicker';
import RangeBar from '../components/RangeBar';
import Receipt from '../components/Receipt';
import StakeField from '../components/StakeField';
import { kindOf } from '../lib/betKind';
import { MIN_BET, breakoutButtonState, rangeButtonState } from '../lib/betState';
import { levelsPercents } from '../lib/chances';
import { startingLevels } from '../lib/defaultRange';
import { distributionOf, evenBand } from '../lib/distribution';
import { cents, money, usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useDebounced, useNow, useResource } from '../lib/hooks';
import { listLadders, rungGap, snap, tickFor } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { anotherOpen, marketNote, useNowAtClose, useReopenWatch } from '../lib/marketPhase';
import { marketHeading } from '../lib/markets';
import { breakoutEstimate, breakoutOutcomesFor, rangeEstimate, rangeOutcomesFor } from '../lib/pricing';
import { rangeComesBack, receiptWords } from '../lib/receiptWords';
import { stakeFrom, stakeRefusal, useStakeCap } from '../lib/stake';
import { useVenue } from '../lib/venue';
import '../styles/builder.css';
import '../styles/range.css';

type Sel = { low: string; high: string };

/**
 * Which side of the two levels the bet takes. `in` is a Range: the price finishes between them. `out` is a Breakout, the same
 * two levels the other way round: it finishes outside them, below the lower or at or above the higher.
 */
type Side = 'in' | 'out';

/**
 * How each side reads where the two differ: the end of the hint under the picker (left off on a phone, where the chart's own
 * labels say it), the names of the two levels, and what is said about the size of the two orders.
 */
const WORDS = {
  in: {
    more: ' to set the floor and the ceiling',
    placed: 'Your range, on the market’s chance of finishing at or above each price. Choose “Make another” to change it.',
    tags: ['Floor', 'Ceiling'],
    sizes: 'Both orders are the same size, so at least one of them pays at settlement.',
  },
  out: {
    more: ' to set the two levels it has to finish outside',
    placed: 'Your breakout, on the market’s chance of finishing at or above each price. Choose “Make another” to change it.',
    tags: ['Lower level', 'Upper level'],
    sizes: 'Both orders are the same size, and only one of them can pay.',
  },
} as const;

/** What a breakout's two orders do, said once under its payoff table. */
const BREAKOUT_PAYS = 'One of the two orders pays if it finishes outside the two levels, and neither pays if it finishes between them.';

const book = (r: Rung) => ({ bid: r.bid, ask: r.ask });
const midOf = (b: { bid: number | null; ask: number | null } | undefined): number | null => (b && b.bid !== null && b.ask !== null ? (b.bid + b.ask) / 2 : null);

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

  // ?side=out opens on a breakout. The Hunch page links here with the two levels already chosen (?low=&high=); levels the
  // ladder no longer has fall back to the default.
  const [side, setSide] = useState<Side>(params.get('side') === 'out' ? 'out' : 'in');
  const [sel, setSel] = useState<Sel | null>(() => {
    const [low, high] = [params.get('low'), params.get('high')];
    return low && high ? { low, high } : null;
  });
  // The stake is whatever the box says, and nothing else: an empty box is no stake, not the last amount that was typed.
  const [stakeText, setStakeText] = useState('10');
  const stake = stakeFrom(stakeText);
  const [cap, learnCap] = useStakeCap();

  const event: MarketEvent | undefined = events.find((e) => e.ticker === ticker) ?? ladders.first;

  // Start on sensible levels; start again when prices refresh and a chosen level is gone or the two are out of order.
  useEffect(() => {
    if (!event) return;
    if (ticker !== event.ticker) setTicker(event.ticker);
    const lo = sel && event.rungs.find((r) => r.symbol === sel.low);
    const hi = sel && event.rungs.find((r) => r.symbol === sel.high);
    if (!lo || !hi || !(lo.strike < hi.strike)) setSel(startingLevels(event, feeCoef, side));
  }, [event, sel, ticker, feeCoef, side]);

  // A ladder that has closed, or is listed but not trading yet, cannot take a bet. Read on the second its close time passes,
  // and again whenever the market list refreshes, so the page says so at once and recovers by itself when the next one opens.
  const clock = Math.max(now, useNowAtClose(event?.expiry));
  const market = event ? marketNote(event, clock, { another: anotherOpen(events, event, clock) }) : null;
  const closed = market?.phase === 'closed';
  useReopenWatch(market !== null, markets.reload);

  const rungOf = (sym?: string): Rung | undefined => event?.rungs.find((r) => r.symbol === sym);
  const lowRung = rungOf(sel?.low);
  const highRung = rungOf(sel?.high);
  const out = side === 'out';

  // Instant estimate while dragging; the executor's quote replaces it when it arrives. One per side, because the two are
  // priced from opposite sides of the same two books.
  const estIn = useMemo(() => (!out && lowRung && highRung ? rangeEstimate(book(lowRung), book(highRung), feeCoef) : null), [out, lowRung, highRung, feeCoef]);
  const estOut = useMemo(() => (out && lowRung && highRung ? breakoutEstimate(book(lowRung), book(highRung), feeCoef) : null), [out, lowRung, highRung, feeCoef]);
  const est = out ? estOut : estIn;

  const dStake = useDebounced(stake, 350);
  // The executor is asked what a stake buys only for a stake it could take: an empty box, one under the minimum or one over
  // the cap is settled here, and the quote is asked for without a stake so the odds and the price still show.
  const askStake = dStake >= MIN_BET && (cap === null || dStake <= cap) ? dStake : undefined;
  // What to ask the executor, debounced as one snapshot of side, ladder and levels: switching side or ladder then never sends
  // the old levels to the new one. Empty until the two levels are in order.
  const asked = event && sel && lowRung && highRung && lowRung.strike < highRung.strike ? `${side}|${event.ticker}|${sel.low}|${sel.high}` : '';
  const dAsked = useDebounced(asked, 200);
  const [dSide, dTicker, dLow, dHigh] = dAsked.split('|') as [Side, string, string, string];
  const quoteQ = useResource<RangeQuoteResponse | BreakoutQuoteResponse | null>(
    `levels:${dAsked}:${askStake ?? 'no-stake'}`,
    () => {
      if (!dAsked) return Promise.resolve(null);
      const args = { event: dTicker, low: dLow, high: dHigh, stake: askStake };
      return dSide === 'out' ? api.quoteBreakout(args) : api.quoteRange(args);
    },
    { live: [[execLive, 'markets']], pollMs: 5000, minGapMs: 1500 },
  );
  // The executor says what the cap on a bet is by refusing a stake above it. Once it has, the page knows.
  useEffect(() => learnCap(quoteQ.error), [quoteQ.error, learnCap]);
  // An answer counts only for these two levels and this side: a range's quote says nothing about the breakout on the same levels.
  const answer = quoteQ.data && sel && quoteQ.data.low.symbol === sel.low && quoteQ.data.high.symbol === sel.high ? quoteQ.data : null;
  const serverOut = out && answer?.product === 'breakout' ? answer : null;
  const serverIn = !out && answer && answer.product !== 'breakout' ? answer : null;
  const server = out ? serverOut : serverIn;
  // The button may rely on the executor's answer only when it is for these levels AND this stake, not one a moment ago.
  const current = !!server && dAsked === asked && dStake === stake;
  const settling = !server;
  const quoteFailed = !!quoteQ.error && !quoteQ.data;
  // A stake refused as too large is an answer, not a failed connection.
  const stakeRefused = quoteFailed ? stakeRefusal(quoteQ.error) : null;

  const offer = server?.quote;
  const chanceWin = out ? (serverOut?.quote.chanceOutside ?? estOut?.chanceOutside ?? null) : (serverIn?.quote.chanceInRange ?? estIn?.chanceInRange ?? null);
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
  const stakeOk = stake >= MIN_BET && (cap === null || stake <= cap);
  const placedBet = phase === 'placed' ? bet : null;
  // What the bet nets each way and what it costs. `contracts` is the size of each order: for a range the dollars at least
  // one order pays wherever it finishes, for a breakout the dollars one order pays if it finishes outside.
  const figures: { win: number; lose: number; cost: number; contracts: number } | null = placedBet?.payoffs
    ? {
        win: (kindOf(placedBet).product === 'breakout' ? placedBet.payoffs.ifOutside : placedBet.payoffs.ifInRange) ?? placedBet.payoffs.ifBothHit,
        lose: (kindOf(placedBet).product === 'breakout' ? placedBet.payoffs.ifInRange : placedBet.payoffs.ifOutside) ?? placedBet.payoffs.ifConditionOnly,
        cost: placedBet.cost,
        contracts: placedBet.legs.length ? Math.min(...placedBet.legs.map((l) => l.quantityFilled)) : 0,
      }
    : !stakeOk
      ? null // no stake that could be placed: no figures, rather than those of a bet nobody can make
      : plan
        ? plan.cost >= MIN_BET
          ? serverOut?.stake
            ? { win: serverOut.stake.ifOutside, lose: serverOut.stake.ifInRange, cost: plan.cost, contracts: plan.contracts }
            : serverIn?.stake
              ? { win: serverIn.stake.ifInRange, lose: serverIn.stake.ifOutside, cost: plan.cost, contracts: plan.contracts }
              : null
          : null // the market cannot fill a bet of any real size: no figures rather than $0.00s
        : estOut
          ? (() => {
              const o = breakoutOutcomesFor(stake, estOut.unitCost);
              return { win: o.ifOutside, lose: o.ifInRange, cost: o.cost, contracts: o.contracts };
            })()
          : estIn
            ? (() => {
                const o = rangeOutcomesFor(stake, estIn.unitCost);
                return { win: o.ifInRange, lose: o.ifOutside, cost: o.cost, contracts: o.contracts };
              })()
            : null;

  // A message about one bet must not outlive a change of levels, side or stake.
  useEffect(() => {
    setError(null);
  }, [sel?.low, sel?.high, stake, side]);

  const shared = { phase, readOnly: venue.readOnly, stake, cap, stakeRefused, market, low: lowRung, high: highRung, answerError: quoteFailed && !stakeRefused };
  const state = out
    ? breakoutButtonState({ ...shared, answer: current ? serverOut : null, est: estOut })
    : rangeButtonState({ ...shared, answer: current ? serverIn : null, est: estIn });
  const canPlace = state.canPlace && !!event && !!sel;

  async function place() {
    if (!event || !sel) return;
    const product = out ? 'breakout' : 'range';
    setPhase('placing');
    setError(null);
    setCallError(null);
    try {
      const res = await api.placeBet({ product, user: 'primary', event: event.ticker, low: sel.low, high: sel.high, stake });
      setBet(res.bet);
      setPhase('placed');
      api.commitCall(res.bet.id).then(setCall, (e) => setCallError(friendly(e)));
    } catch (e) {
      learnCap(e);
      setError(friendly(e, { product }));
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
    setSel(startingLevels(e, feeCoef, side));
    again();
  }

  /** The other side of the same two levels. They stay where they are, so the two bets can be compared like for like. */
  function turn(next: Side) {
    if (next === side) return;
    setSide(next);
    again();
  }

  const loadingFirst = markets.loading && !markets.data;
  const both = !!lowRung && !!highRung;
  const words = WORDS[side];
  const sentence = receiptWords({
    product: out ? 'breakout' : 'range',
    condition: { symbol: '', label: '', strike: lowRung?.strike ?? 0 },
    target: { symbol: '', label: '', strike: highRung?.strike ?? 0 },
  });
  // The chances as whole percents, worked out once from the chance of finishing at or above each level (the executor's
  // prices when it has answered). The bar, the figure under it, the table and the chart's two labels all print these, so they
  // agree with each other and add to 100.
  const [midLow, midHigh] = [midOf(server?.low ?? lowRung), midOf(server?.high ?? highRung)];
  const shares = chanceWin !== null && midLow !== null && midHigh !== null ? levelsPercents(side, midLow, midHigh) : null;
  const amount = (kind: 'win' | 'back' | 'lose') => (!figures ? '–' : usdSigned(kind === 'win' ? figures.win : figures.lose));
  // The most a stake can be right now: what is resting on the market, or the venue's cap on one bet if that is lower.
  const fits = depth && depth.maxStake >= 1 ? Math.floor(depth.maxStake) : null;
  const stakeNote =
    plan?.reduced && state.blockedBy !== 'thin'
      ? `The market can only fill about ${usd(plan.cost)} at these prices, so the bet will be that size.`
      : cap !== null && (fits === null || cap <= fits)
        ? `Up to ${usd(cap, 0)} a bet here.`
        : fits !== null
          ? `Up to ${usd(fits, 0)} fits right now.`
          : words.sizes;
  const lowText = lowRung ? money(lowRung.strike) : '…';
  const highText = highRung ? money(highRung.strike) : '…';
  // How far the market expects the price to travel: the band it gives an even chance of holding. It is the yardstick for
  // choosing a side, so it is said in both. Rounded to a step that fits the ladder, since it is read between rungs.
  const even = useMemo(() => {
    const levels = event ? distributionOf(event.rungs)?.levels : undefined;
    const band = levels ? evenBand(levels) : null;
    if (!levels || !band) return null;
    const tick = tickFor(rungGap(levels.map((l) => l.strike)));
    const [low, high] = [snap(band.low, tick), snap(band.high, tick)];
    return high > low ? { low, high } : null;
  }, [event]);

  return (
    <div className="page builder range-page">
      <header className="page-head">
        <div>
          <span className="eyebrow">A bet on how far the price moves</span>
          <h1 className="h-page">Range</h1>
          <p className="lede">Choose two levels, then bet that the price stays put and finishes between them, or that it moves far enough to finish outside them, up or down.</p>
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
              now={clock}
            />
            <div className="direction" role="radiogroup" aria-label="Which side of the two levels the bet takes">
              <span className="eyebrow">Bet that the price</span>
              <div className="switch">
                {(
                  [
                    ['in', 'Stays inside'],
                    ['out', 'Breaks out'],
                  ] as const
                ).map(([s, label]) => (
                  <button key={s} type="button" role="radio" aria-checked={side === s} className={side === s ? 'is-on' : ''} onClick={() => turn(s)} disabled={phase === 'placing'}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="chart-hint">
              {phase === 'placed' ? (
                words.placed
              ) : closed ? (
                'The last prices this market showed before it closed.'
              ) : (
                <>
                  Chance of finishing at or above each price. Drag the two markers<span className="hint-more">{words.more}</span>, or tap the chart.
                </>
              )}
            </p>
            {loadingFirst ? (
              <div className="skeleton chart-skel" />
            ) : event && sel ? (
              // A placed bet's chart is a record, and so is a market that has closed: there is nothing left to choose on it.
              <div className={phase === 'placed' || closed ? 'chart-locked' : undefined}>
                <LadderChart
                  rungs={event.rungs}
                  condition={sel.low}
                  target={sel.high}
                  mode={out ? 'breakout' : 'range'}
                  // What each handle's label says: a range's are "at or above the floor" and "below the ceiling", a breakout's
                  // "below the lower level" and "at or above the upper".
                  chances={shares ? (out ? [shares.below, shares.above] : [shares.between + shares.above, shares.below + shares.between]) : null}
                  onChange={(low, high) => phase !== 'placed' && !closed && setSel({ low, high })}
                />
              </div>
            ) : (
              <div className="empty">No markets are open right now. Check back in a few minutes.</div>
            )}
            <div className="chart-foot">
              <span>
                <i className="lg lg-curve" /> Market chance
              </span>
              <span className="foot-band">
                <i className="lg lg-band" /> Buy and sell prices
              </span>
              {out ? (
                <>
                  <span>
                    <i className="lg lg-win" /> Where it wins
                  </span>
                  <span>
                    <i className="lg lg-lose" /> Where it loses
                  </span>
                </>
              ) : (
                <span>
                  <i className="lg lg-win" /> Your range
                </span>
              )}
            </div>
            {even && (
              <p className="chart-even">
                <span className="hint-more">The market gives an </span>even chance<span className="hint-more"> of finishing</span> between <b>{money(even.low)}</b> and <b>{money(even.high)}</b>.
              </p>
            )}
          </section>

          <section className="card payoff" aria-label="How this bet pays">
            <header className="card-head">
              <h2 className="h-card">How this bet pays</h2>
              <span className="fine">{figures ? `On a ${usd(figures.cost)} bet` : 'Per bet'}</span>
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
                {sentence.outcomes.map((o) => (
                  <tr key={o.kind} data-kind={o.kind}>
                    <td>
                      <i aria-hidden="true" />
                      {both ? o.label : '…'}
                    </td>
                    <td className="n">{shares && o.kind !== 'back' ? `${shares[o.kind]}%` : '–'}</td>
                    <td className="n">{amount(o.kind)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* On a phone this line stands in for the one on the ticket (range.css), so each screen says it once. */}
            <p className="fine rg-always">{out ? BREAKOUT_PAYS : rangeComesBack(figures ? usd(figures.contracts) : 'part')}</p>
          </section>

          {event && lowRung && highRung && (
            <DistCard rungs={event.rungs} shape={{ kind: out ? 'breakout' : 'range', low: lowRung.strike, high: highRung.strike }} zones={shares ? [shares.below, shares.between, shares.above] : null} />
          )}

          {event && (
            <LadderTable
              rungs={event.rungs}
              picked={sel ? { [sel.low]: words.tags[0], [sel.high]: words.tags[1] } : {}}
              rowClass={(r) => (both && r.strike > lowRung!.strike && r.strike < highRung!.strike ? (out ? 'is-between' : 'is-inside') : undefined)}
            />
          )}
        </div>

        <aside className="card quote-card" aria-live="polite">
          {phase === 'placed' && bet ? (
            <Receipt bet={bet} call={call} callError={callError} onAgain={again} />
          ) : (
            <>
              <div className="q-title">
                {/* The asset and the close in the viewer's own time, like the picker. The exchange's title (its hour is New York's) is the tooltip. */}
                <span className="eyebrow" title={event?.title}>
                  {event ? marketHeading(event, clock) : 'Loading'}
                </span>
                <h2 className="q-sentence">
                  {out ? (
                    <>
                      Will it finish outside <em>{lowText}</em> to <em>{highText}</em>?
                    </>
                  ) : (
                    <>
                      Will it finish between <em>{lowText}</em> and <em>{highText}</em>?
                    </>
                  )}
                </h2>
              </div>

              {shares ? <RangeBar shares={shares} side={side} /> : <div className="skeleton bar-skel" />}

              <div className="rg-figures">
                <dl className={`nums ${settling ? 'is-est' : ''}`}>
                  <div>
                    <dt>{out ? 'Chance outside' : 'Chance inside'}</dt>
                    <dd>{shares ? `${shares.win}%` : '–'}</dd>
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
                  {figures && (
                    <>
                      You pay <b>{usd(figures.cost)}</b> now.{' '}
                    </>
                  )}
                  {out ? (
                    <>
                      It wins if it finishes below <b>{lowText}</b> or at <b>{highText}</b> or above: no need to pick a direction. Between them, neither order pays.
                    </>
                  ) : (
                    rangeComesBack(figures ? usd(figures.contracts) : 'part')
                  )}
                </p>
              </div>

              {verdict === 'warn' && !state.notice && fair !== null && pricePaid !== null && (
                <p className="note note-warn">
                  Costs a little more than fair value: {cents(pricePaid)} per $1 against a fair {cents(fair)}.
                </p>
              )}

              <StakeField id="stake" text={stakeText} stake={stake} onText={setStakeText} max={cap} note={stakeNote} />

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
