import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Bet, CallRecord, Direction, MarketEvent, QuoteResponse, Rung } from '../api/types';
import DistCard from '../components/DistCard';
import LadderChart from '../components/LadderChart';
import LadderTable from '../components/LadderTable';
import MarketPicker from '../components/MarketPicker';
import ProbBar from '../components/ProbBar';
import Receipt from '../components/Receipt';
import StakeField from '../components/StakeField';
import { MIN_BET, buttonState } from '../lib/betState';
import { parlayPercents } from '../lib/chances';
import { defaultPair } from '../lib/defaultPair';
import { cents, money, usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useDebounced, useNow, useResource } from '../lib/hooks';
import { listLadders } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { anotherOpen, marketNote, useNowAtClose, useReopenWatch } from '../lib/marketPhase';
import { marketHeading } from '../lib/markets';
import { estimate, mirrorBook, outcomesFor } from '../lib/pricing';
import { receiptWords } from '../lib/receiptWords';
import { stakeFrom, stakeRefusal, useStakeCap } from '../lib/stake';
import { useVenue } from '../lib/venue';
import '../styles/builder.css';

/**
 * How each direction reads. The two prices have one name each wherever they appear: the first level (the one that has to
 * hold) and the target (what the bet is about). A rising bet holds its first level and reaches its target; a falling one
 * stays under its first level and falls below its target.
 */
const WORDS = {
  up: {
    lede: 'Bet that a price reaches a target, given that it holds a first level below it. If the first level fails, your stake comes back.',
    more: ': the lower one is the first level, the higher one the target',
  },
  down: {
    lede: 'Bet that a price falls below a target, given that it stays under a first level above it. If the first level fails, your stake comes back.',
    more: ': the higher one is the first level to stay under, the lower one the target to fall below',
  },
} as const;

/** A rung as a bet going `direction` sees it: a falling bet reads the same contract from its NO side. */
const asSeen = (r: Rung, direction: Direction) => (direction === 'down' ? { ...r, ...mirrorBook(r) } : r);

/** Whether two rungs are in the order the direction needs: the first level below the target going up, above it going down. */
const inOrder = (c: Rung, t: Rung, direction: Direction) => (direction === 'down' ? c.strike > t.strike : c.strike < t.strike);

export default function Parlay() {
  const venue = useVenue();
  const now = useNow(20000);
  const markets = useResource('markets', () => api.markets(), { live: [[execLive, 'markets']], pollMs: 4000, minGapMs: 800 });
  // Real exchanges list dozens of ladders, most with no prices at a given moment. The picker offers the ones with prices;
  // the page opens on one you can bet on. The rest are a tap away, never hidden without saying so.
  const [showUnpriced, setShowUnpriced] = useState(false);
  const ladders = useMemo(() => listLadders(markets.data?.events ?? [], showUnpriced), [markets.data, showUnpriced]);
  const events = ladders.shown;

  // The Markets page links here with ?market=TICKER; a ladder with no prices is listed when that is the one asked for.
  const [params] = useSearchParams();
  const wanted = params.get('market');
  const [ticker, setTicker] = useState<string | null>(wanted);
  useEffect(() => {
    if (wanted && !showUnpriced && ladders.unpriced.some((e) => e.ticker === wanted)) setShowUnpriced(true);
  }, [wanted, showUnpriced, ladders.unpriced]);

  const [direction, setDirection] = useState<Direction>(params.get('direction') === 'down' ? 'down' : 'up');
  // The Hunch page links here with a bet already chosen (?condition=&target=, the executor's names for the first level and
  // the target). If the ladder no longer has those two prices, or they are not in the order the direction needs, the effect
  // below falls back to the default.
  const [sel, setSel] = useState<{ c: string; t: string } | null>(() => {
    const [c, t] = [params.get('condition'), params.get('target')];
    return c && t ? { c, t } : null;
  });
  // The stake is whatever the box says, and nothing else: an empty box is no stake, not the last amount that was typed.
  const [stakeText, setStakeText] = useState('10');
  const stake = stakeFrom(stakeText);
  const [cap, learnCap] = useStakeCap();

  const event: MarketEvent | undefined = events.find((e) => e.ticker === ticker) ?? ladders.first;

  // Start on the first event with a good default; reset when the hour rolls over and symbols disappear.
  useEffect(() => {
    if (!event) return;
    if (ticker !== event.ticker) setTicker(event.ticker);
    const c = sel && event.rungs.find((r) => r.symbol === sel.c);
    const t = sel && event.rungs.find((r) => r.symbol === sel.t);
    if (!c || !t || !inOrder(c, t, direction)) setSel(defaultPair(event, direction));
  }, [event, sel, ticker, direction]);

  // A ladder that has closed, or is listed but not trading yet, cannot take a bet. Read on the second its close time passes,
  // and again whenever the market list refreshes, so the page says so at once and recovers by itself when the next one opens.
  const clock = Math.max(now, useNowAtClose(event?.expiry));
  const market = event ? marketNote(event, clock, { another: anotherOpen(events, event, clock) }) : null;
  const closed = market?.phase === 'closed';
  useReopenWatch(market !== null, markets.reload);

  const rungOf = (sym?: string): Rung | undefined => event?.rungs.find((r) => r.symbol === sym);
  const cRung = rungOf(sel?.c);
  const tRung = rungOf(sel?.t);

  // Instant estimate while dragging; the executor's quote replaces it when it arrives.
  const feeCoef = markets.data?.feeCoefCharged ?? 0;
  const est = useMemo(() => {
    if (!cRung || !tRung) return null;
    const [c, t] = [asSeen(cRung, direction), asSeen(tRung, direction)];
    return estimate({ bid: c.bid, ask: c.ask }, { bid: t.bid, ask: t.ask }, feeCoef);
  }, [cRung, tRung, feeCoef, direction]);

  const dStake = useDebounced(stake, 350);
  // The executor is asked what a stake buys only for a stake it could take: an empty box, one under the minimum or one over
  // the cap is settled here, and the quote is asked for without a stake so the odds and the price still show.
  const askStake = dStake >= MIN_BET && (cap === null || dStake <= cap) ? dStake : undefined;
  // What to ask the executor, debounced as one snapshot of direction, ladder and levels: a switch of direction or ladder then
  // never sends the old two to the new one. Empty until they are in the order the direction needs.
  const asked = event && sel && cRung && tRung && inOrder(cRung, tRung, direction) ? `${direction}|${event.ticker}|${sel.c}|${sel.t}` : '';
  const dAsked = useDebounced(asked, 200);
  const [dDirection, dTicker, dC, dT] = dAsked.split('|') as [Direction, string, string, string];
  // One cached answer per bet and stake: going back to one you looked at is instant, and prices that move refresh it.
  const quoteQ = useResource<QuoteResponse | null>(
    `quote:${dAsked}:${askStake ?? 'no-stake'}`,
    () => (dAsked ? api.quote({ event: dTicker, condition: dC, target: dT, stake: askStake, direction: dDirection }) : Promise.resolve(null)),
    { live: [[execLive, 'markets']], pollMs: 5000, minGapMs: 1500 },
  );
  // The executor says what the cap on a bet is by refusing a stake above it. Once it has, the page knows.
  useEffect(() => learnCap(quoteQ.error), [quoteQ.error, learnCap]);
  const server = quoteQ.data && sel && quoteQ.data.condition.symbol === sel.c && quoteQ.data.target.symbol === sel.t ? quoteQ.data : null;
  // The button may rely on the executor's answer only when it is for these levels AND this stake, not one a moment ago.
  const current = !!server && dAsked === asked && dStake === stake;
  const settling = !server; // showing the estimate
  const quoteFailed = !!quoteQ.error && !quoteQ.data;
  // A stake refused as too large is an answer, not a failed connection.
  const stakeRefused = quoteFailed ? stakeRefusal(quoteQ.error) : null;

  const offer = server?.quote;
  const chanceCondition = offer?.chanceCondition ?? est?.chanceCondition ?? null;
  const chanceBoth = offer?.chanceBothHappen ?? est?.chanceBothHappen ?? null;
  const fair = offer?.fairPrice ?? est?.fairPrice ?? null;
  const pricePaid = offer?.pricePaid ?? est?.pricePaid ?? null;
  const cashOut100 = offer?.cashOutPer100 ?? est?.cashOutPer100 ?? null;
  const verdict = offer?.verdict ?? est?.verdict ?? null;
  // A "fair price" above $1 means the two prices are out of step; it is not a number to show.
  const fairShown = fair !== null && fair < 1 ? fair : null;
  // The three chances as whole percents, worked out once. The bar, the figure under it, the table and the chart's two labels
  // all print these, so they agree with each other and add to 100.
  const shares = chanceCondition !== null && chanceBoth !== null ? parlayPercents(direction, chanceCondition, chanceBoth) : null;

  // ------------------------------------------------------------------ place flow
  const [phase, setPhase] = useState<'idle' | 'placing' | 'placed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bet, setBet] = useState<Bet | null>(null);
  const [call, setCall] = useState<CallRecord | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const plan = server?.stake;
  const depth = server?.depth && 'maxStake' in server.depth ? server.depth : null;
  const stakeOk = stake >= MIN_BET && (cap === null || stake <= cap);
  // Once a bet is placed the panel shows that bet's figures, which may be smaller than the stake that was asked for.
  const placedBet = phase === 'placed' ? bet : null;
  const out = placedBet?.payoffs
    ? { win: placedBet.payoffs.ifBothHit, lose: placedBet.payoffs.ifConditionOnly, cost: placedBet.cost }
    : !stakeOk
      ? null // no stake that could be placed: no figures, rather than those of a bet nobody can make
      : plan
        ? plan.cost >= MIN_BET
          ? { win: plan.ifBothHit, lose: plan.ifConditionOnly, cost: plan.cost }
          : null // the market cannot fill a bet of any real size: no figures rather than $0.00s
        : pricePaid
          ? (() => {
              const o = outcomesFor(stake, pricePaid);
              return { win: o.ifBothHit, lose: o.ifConditionOnly, cost: o.cost };
            })()
          : null;

  // A message about one bet must not outlive a change of levels or stake.
  useEffect(() => {
    setError(null);
  }, [sel?.c, sel?.t, stake, direction]);

  const state = buttonState({
    phase,
    readOnly: venue.readOnly,
    stake,
    cap,
    stakeRefused,
    market,
    direction,
    condition: cRung,
    target: tRung,
    answer: current ? server : null,
    answerError: quoteFailed && !stakeRefused,
    est,
  });
  const canPlace = state.canPlace && !!event && !!sel;

  async function place() {
    if (!event || !sel) return;
    setPhase('placing');
    setError(null);
    setCallError(null);
    try {
      const res = await api.placeBet({ user: 'primary', event: event.ticker, condition: sel.c, target: sel.t, direction, stake });
      setBet(res.bet);
      setPhase('placed');
      api.commitCall(res.bet.id).then(setCall, (e) => setCallError(friendly(e)));
    } catch (e) {
      learnCap(e);
      setError(friendly(e, { product: 'parlay', direction }));
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
    setSel(defaultPair(e, direction));
    again();
  }

  function turn(next: Direction) {
    if (next === direction) return;
    setDirection(next);
    setSel(event ? defaultPair(event, next) : null);
    again();
  }

  const loadingFirst = markets.loading && !markets.data;
  const words = WORDS[direction];
  const sentence = receiptWords({ product: 'parlay', direction, condition: { symbol: '', label: '', strike: cRung?.strike ?? 0 }, target: { symbol: '', label: '', strike: tRung?.strike ?? 0 } });
  // The most a stake can be right now: what is resting on the market, or the venue's cap on one bet if that is lower.
  const fits = depth && depth.maxStake >= 1 ? Math.floor(depth.maxStake) : null;
  const stakeNote =
    plan?.reduced && state.blockedBy !== 'thin'
      ? `The market can only fill about ${usd(plan.cost)} at this price, so the bet will be that size.`
      : cap !== null && (fits === null || cap <= fits)
        ? `Up to ${usd(cap, 0)} a bet here.`
        : fits !== null
          ? `Up to ${usd(fits, 0)} fits right now.`
          : 'The two orders are sized so your stake comes back if the first level fails.';

  return (
    <div className="page builder">
      <header className="page-head">
        <div>
          <h1 className="h-page">Stake Back</h1>
          <p className="lede">{words.lede}</p>
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
            <div className="direction" role="radiogroup" aria-label="Which way the bet looks">
              <span className="eyebrow">Bet that the price</span>
              <div className="switch">
                {(
                  [
                    ['up', 'Reaches higher'],
                    ['down', 'Falls lower'],
                  ] as const
                ).map(([d, label]) => (
                  <button key={d} type="button" role="radio" aria-checked={direction === d} className={direction === d ? 'is-on' : ''} onClick={() => turn(d)} disabled={phase === 'placing'}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="chart-hint">
              {phase === 'placed' ? (
                'Your bet, on the market’s chance of finishing at or above each price. Choose “Make another” to change it.'
              ) : closed ? (
                'The last prices this market showed before it closed.'
              ) : (
                <>
                  Chance of finishing at or above each price. Drag the two markers, or tap the chart<span className="hint-more">{words.more}</span>.
                </>
              )}
            </p>
            {loadingFirst ? (
              <div className="skeleton chart-skel" />
            ) : event && sel ? (
              // Once the bet is placed the markers show that bet and stay put; "Make another" frees them again. A market that
              // has closed is a record too: there is nothing left to choose on it.
              <div className={phase === 'placed' || closed ? 'chart-locked' : undefined}>
                <LadderChart
                  rungs={event.rungs}
                  condition={sel.c}
                  target={sel.t}
                  mode={direction}
                  chances={shares ? [shares.holds, shares.win] : null}
                  onChange={(c, t) => phase !== 'placed' && !closed && setSel({ c, t })}
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
              <span>
                <i className="lg lg-win" /> Your bet
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
                {sentence.outcomes.map((o) => (
                  <tr key={o.kind} data-kind={o.kind}>
                    <td>
                      <i aria-hidden="true" />
                      {cRung && tRung ? o.label : '…'}
                    </td>
                    <td className="n">{shares ? `${shares[o.kind]}%` : '–'}</td>
                    <td className="n">{!out ? '–' : o.kind === 'back' ? 'Stake back' : usdSigned(o.kind === 'win' ? out.win : out.lose)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {event && cRung && tRung && <DistCard rungs={event.rungs} shape={{ kind: direction, condition: cRung.strike, target: tRung.strike }} zones={shares?.zones} />}

          {event && <LadderTable rungs={event.rungs} picked={sel ? { [sel.c]: 'First level', [sel.t]: 'Target' } : {}} />}
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
                  {direction === 'down' ? (
                    <>
                      Given it stays under <em>{cRung ? money(cRung.strike) : '…'}</em>, will it fall below <em>{tRung ? money(tRung.strike) : '…'}</em>?
                    </>
                  ) : (
                    <>
                      Given <em>{cRung ? money(cRung.strike) : '…'}</em> or above, will it reach <em>{tRung ? money(tRung.strike) : '…'}</em>?
                    </>
                  )}
                </h2>
              </div>

              {chanceCondition !== null && chanceBoth !== null ? <ProbBar chanceCondition={chanceCondition} chanceBoth={chanceBoth} direction={direction} /> : <div className="skeleton bar-skel" />}

              <dl className={`nums ${settling ? 'is-est' : ''}`}>
                <div>
                  <dt>Chance of winning</dt>
                  <dd>{shares ? `${shares.win}%` : '–'}</dd>
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

              {verdict === 'warn' && !state.notice && fairShown !== null && pricePaid !== null && (
                <p className="note note-warn">
                  Costs a little more than fair value: {cents(pricePaid)} per $1 against a fair {cents(fairShown)}.
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
