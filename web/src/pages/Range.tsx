import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, BreakoutQuoteResponse, CallRecord, MarketEvent, PlaceBreakoutRequest, PlaceRangeRequest, RangeQuoteResponse, Rung } from '../api/types';
import DistCard from '../components/DistCard';
import HowItWorks from '../components/HowItWorks';
import LadderChart, { ChartKey } from '../components/LadderChart';
import LadderTable from '../components/LadderTable';
import MarketPicker from '../components/MarketPicker';
import PlaceBar, { usePhone, useRescueFocus } from '../components/PlaceBar';
import RangeBar from '../components/RangeBar';
import Receipt from '../components/Receipt';
import StakeField from '../components/StakeField';
import { kindOf } from '../lib/betKind';
import { MIN_BET, breakoutButtonState, isRefusal, maxPriceFor, rangeButtonState, stakeNote as stakeNoteFor } from '../lib/betState';
import { levelsPercents } from '../lib/chances';
import { startingLevels } from '../lib/defaultRange';
import { cents, money, usd, usdSigned } from '../lib/format';
import { friendly, sealProblem, type SealProblem } from '../lib/friendly';
import { useDebounced, useNow, useResource } from '../lib/hooks';
import { hasPrices, listLadders } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { anotherOpen, marketNote, useNowAtClose, useReopenWatch } from '../lib/marketPhase';
import { assetLabel, marketHeading } from '../lib/markets';
import { breakoutEstimate, breakoutOutcomesFor, rangeEstimate, rangeOutcomesFor } from '../lib/pricing';
import { landingOf, landingWords, rangeComesBack, receiptWords } from '../lib/receiptWords';
import { rovingKeys } from '../lib/roving';
import { stakeFrom, stakeRefusal, useStakeCap } from '../lib/stake';
import { mayHaveBeenPlaced, sameAttempt, useAttempts, useUnconfirmedBet } from '../lib/unconfirmedBet';
import { keepMode, useVenue } from '../lib/venue';
import '../styles/builder.css';
import '../styles/range.css';

type Sel = { low: string; high: string };

/**
 * Which side of the two levels the bet takes. `in` is a Range: the price finishes between them. `out` is a Breakout, the same
 * two levels the other way round: it finishes outside them, below the lower or at or above the higher.
 */
type Side = 'in' | 'out';

/** How each side reads where the two differ: the page's name, its one-line explanation, the names of the two levels, and what is said about the size of the two orders. */
const WORDS = {
  in: {
    title: 'Range',
    lede: 'Pick a lower and a higher level. You win if the price finishes between them.',
    tags: ['Lower level', 'Higher level'],
    sizes: 'The two orders are the same size, so at least one of them pays when the market closes.',
  },
  out: {
    title: 'Breakout',
    lede: 'Pick a lower and a higher level. You win if the price finishes outside them.',
    tags: ['Lower level', 'Higher level'],
    sizes: 'The two orders are the same size, and only one of them can pay.',
  },
} as const;

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

  // The Markets page links here with ?market=TICKER; a market with no prices is listed when that is the one asked for.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('market');
  const [ticker, setTicker] = useState<string | null>(wanted);
  useEffect(() => {
    if (wanted && !showUnpriced && ladders.unpriced.some((e) => e.ticker === wanted)) setShowUnpriced(true);
  }, [wanted, showUnpriced, ladders.unpriced]);
  // A link to a market the exchange no longer lists opens on another one. It says so, until the person chooses for themselves.
  const [chose, setChose] = useState(false);
  const unlisted = !!wanted && !chose && !!markets.data && !markets.data.events.some((e) => e.ticker === wanted);

  // ?side=out opens on a Breakout, and the address follows the switch, so a reload or a shared link keeps the side. The Hunch
  // page links here with the two levels already chosen (?low=&high=); levels the market no longer has fall back to the default.
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
  // A market that lists prices but has none to bet on right now has no chart to draw and no bet to build.
  const priced = !!event && hasPrices(event);

  // Start on sensible levels; start again when prices refresh and a chosen level is gone or the two are out of order.
  useEffect(() => {
    if (!event) return;
    if (ticker !== event.ticker) setTicker(event.ticker);
    const lo = sel && event.rungs.find((r) => r.symbol === sel.low);
    const hi = sel && event.rungs.find((r) => r.symbol === sel.high);
    if (!lo || !hi || !(lo.strike < hi.strike)) setSel(startingLevels(event, feeCoef, side));
  }, [event, sel, ticker, feeCoef, side]);

  // A market that has closed, or is listed but not trading yet, cannot take a bet. Read on the second its close time passes,
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
  const [callError, setCallError] = useState<SealProblem | null>(null);
  // One id for each attempt: pressing Place bet again after an answer was lost sends the same id, so the executor places the bet
  // once whichever of the two requests got through. A new bet, a new stake or an answered attempt gets a new one.
  const attempts = useAttempts();
  // What the last attempt sent, and the price per $1 the person was shown when they pressed the button.
  const sent = useRef<{ req: PlaceRangeRequest | PlaceBreakoutRequest; shown: number | null } | null>(null);
  // When the price moved out from under the person: the button waits for the quote to be read again after that, so the next press
  // is at the new price and not at the one that was just refused.
  const [movedAt, setMovedAt] = useState<number | null>(null);
  // Whether the last attempt may have been placed although no answer came. The hold on the button lasts ten seconds; this note
  // does not: it stays until the person presses again or changes the bet, because that is when they need to know to look.
  const [unsure, setUnsure] = useState(false);
  // One press at a time: the button is disabled once the page has re-rendered, but a press repeated within the same task (a
  // screen reader's activate, a script) gets here before that.
  const busy = useRef(false);

  const shared = { phase, readOnly: venue.readOnly, stake, cap, stakeRefused, market, low: lowRung, high: highRung, answerError: quoteFailed && !stakeRefused };
  const state = out
    ? breakoutButtonState({ ...shared, answer: current ? serverOut : null, est: estOut })
    : rangeButtonState({ ...shared, answer: current ? serverIn : null, est: estIn });

  // A bet that cannot be placed has no size and no winnings: the quote may still carry the figures of a bet nobody can make, and
  // they are neither shown as one ("On a $8.17 bet") nor described as what the bet will be.
  const refusing = isRefusal(state);

  const plan = server?.stake;
  const depth = server?.depth && 'maxStake' in server.depth ? server.depth : null;
  const stakeOk = stake >= MIN_BET && (cap === null || stake <= cap);
  const placedBet = phase === 'placed' ? bet : null;
  // Only a bet that is fully in place has results to tabulate; one that is not (see `landingOf`) has none to show.
  const hedgedBet = placedBet && landingOf(placedBet) === 'placed' ? placedBet : null;
  // What the bet nets each way and what it costs. `contracts` is the size of each order: for a range the dollars at least
  // one order pays wherever it finishes, for a breakout the dollars one order pays if it finishes outside.
  const figures: { win: number; lose: number; cost: number; contracts: number } | null = hedgedBet?.payoffs
    ? {
        win: (kindOf(hedgedBet).product === 'breakout' ? hedgedBet.payoffs.ifOutside : hedgedBet.payoffs.ifInRange) ?? hedgedBet.payoffs.ifBothHit,
        lose: (kindOf(hedgedBet).product === 'breakout' ? hedgedBet.payoffs.ifInRange : hedgedBet.payoffs.ifOutside) ?? hedgedBet.payoffs.ifConditionOnly,
        cost: hedgedBet.cost,
        contracts: hedgedBet.legs.length ? Math.min(...hedgedBet.legs.map((l) => l.quantityFilled)) : 0,
      }
    : placedBet && !hedgedBet
      ? null
      : !stakeOk || refusing
        ? null // no stake that could be placed, or a bet that is refused: no figures, rather than those of a bet nobody can make
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

  // A message about one bet must not outlive a change of levels, side or stake, nor the connection coming back.
  useEffect(() => {
    setError(null);
    setUnsure(false);
    setMovedAt(null);
  }, [sel?.low, sel?.high, stake, side]);
  useEffect(() => {
    const clear = () => setError(null);
    window.addEventListener('online', clear);
    return () => window.removeEventListener('online', clear);
  }, []);

  /** Seals the call of a bet on Solana. Only a bet that is fully in place has one to seal: the chain service refuses the rest. */
  function seal(id: string) {
    api.commitCall(id).then(setCall, (e) => setCallError(sealProblem(e)));
  }

  /** The executor's answer to a placement: the receipt, which tells what the bet turned into. Only a fully hedged bet is sealed. */
  function adopt(placed: Bet) {
    attempts.spend();
    setBet(placed);
    setPhase('placed');
    setError(null);
    setUnsure(false);
    setCall(null);
    setCallError(null);
    if (landingOf(placed) === 'placed') seal(placed.id);
  }

  /** A refusal is the executor's answer: nothing was bought, and the next try is a new attempt. */
  function refused(e: unknown, shown: number | null) {
    attempts.spend();
    learnCap(e);
    setUnsure(false); // an answer: nothing was bought
    if (e instanceof ApiError && e.code === 'price_above_limit') setMovedAt(Date.now());
    setError(friendly(e, { product: out ? 'breakout' : 'range', shownPrice: shown }));
  }

  // After a dropped connection or a server error, the bet may have been placed anyway. The button is held while the list of
  // bets is read to find out, and once the same request is sent again under the same id: the executor places nothing twice for
  // one id, so that gives the bet that was placed, or places it now, but never two. The person is told where to look meanwhile.
  const attemptAt = useRef(0);
  const [holding, setHolding] = useUnconfirmedBet(
    () => api.bets('primary').then((r) => r.bets),
    (b) =>
      sameAttempt(
        b,
        sent.current?.req.requestId ?? null,
        b.eventTicker === event?.ticker && b.condition.symbol === sel?.low && b.target.symbol === sel?.high && kindOf(b).product === (out ? 'breakout' : 'range') && Date.parse(b.createdAt) >= attemptAt.current - 3000,
      ),
    adopt,
    {
      send: () => (sent.current ? api.placeBet(sent.current.req).then((r) => r.bet) : Promise.reject(new Error('nothing was sent'))),
      refused: (e) => {
        refused(e, sent.current?.shown ?? null);
        quoteQ.reload();
        markets.reload();
      },
    },
  );
  const stale = movedAt !== null && !(quoteQ.updatedAt !== null && quoteQ.updatedAt > movedAt);
  const canPlace = state.canPlace && !!event && !!sel && !holding && !stale;

  async function place() {
    if (!event || !sel || busy.current) return;
    busy.current = true;
    const product = out ? 'breakout' : 'range';
    attemptAt.current = Date.now();
    setPhase('placing');
    setError(null);
    setUnsure(false);
    setCallError(null);
    // The price per $1 on the quote the button was built on: the bet may cost up to a little more than that, and no more.
    const shown = server?.quote.pricePaid ?? null;
    const maxPrice = maxPriceFor(shown);
    const req: PlaceRangeRequest | PlaceBreakoutRequest = {
      product,
      user: 'primary',
      event: event.ticker,
      low: sel.low,
      high: sel.high,
      stake,
      ...(maxPrice !== undefined ? { maxPrice } : {}),
      requestId: attempts.idFor(`${product}|${event.ticker}|${sel.low}|${sel.high}|${stake}`),
    };
    sent.current = { req, shown };
    try {
      const res = await api.placeBet(req);
      adopt(res.bet);
    } catch (e) {
      setPhase('idle');
      if (mayHaveBeenPlaced(e)) {
        setHolding(true);
        setUnsure(true);
      } else refused(e, shown);
      quoteQ.reload(); // the market has moved on from the answer the button was built on
      markets.reload();
    } finally {
      busy.current = false;
    }
  }

  /** Tries to seal the call again after it could not be sealed. */
  function sealAgain() {
    if (!bet) return;
    setCallError(null);
    seal(bet.id);
  }

  /** Back to a bet that has not been placed: the receipt, and any message about the last attempt, go. */
  function reset() {
    setPhase('idle');
    setBet(null);
    setCall(null);
    setError(null);
    setUnsure(false);
  }

  /** "Make another": the button that was just used is gone, so focus goes to the stake box, where the next bet starts. */
  function again() {
    reset();
    window.setTimeout(() => document.getElementById('stake')?.focus({ preventScroll: true }), 0);
  }

  function pick(e: MarketEvent) {
    setChose(true);
    setTicker(e.ticker);
    setSel(startingLevels(e, feeCoef, side));
    reset();
  }

  /** The other side of the same two levels. They stay where they are, so the two bets can be compared like for like. */
  function turn(next: Side) {
    if (next === side) return;
    setSide(next);
    // The address follows, so a reload or a shared link opens on the same bet.
    setParams(
      (prev) => {
        const q = new URLSearchParams(prev);
        if (next === 'out') q.set('side', 'out');
        else q.delete('side');
        return q;
      },
      { replace: true },
    );
    reset();
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
  // prices when it has answered). The bar, the figure under it, the table and the histogram all print these, so they agree
  // with each other and add to 100.
  const [midLow, midHigh] = [midOf(server?.low ?? lowRung), midOf(server?.high ?? highRung)];
  const shares = chanceWin !== null && midLow !== null && midHigh !== null ? levelsPercents(side, midLow, midHigh) : null;
  const amount = (kind: 'win' | 'back' | 'lose') => (!figures ? '–' : usdSigned(kind === 'win' ? figures.win : figures.lose));
  // The most a stake can be right now: what is on offer on the market, or the venue's cap on one bet if that is lower. Nothing is
  // said about a stake while bets are switched off: there is no bet to size.
  const fits = depth && depth.maxStake >= 1 ? Math.floor(depth.maxStake) : null;
  const stakeNote = stakeNoteFor({ readOnly: venue.readOnly, reducedTo: plan?.reduced ? plan.cost : null, refusing, cap, fits, at: 'these prices', fallback: words.sizes });
  const lowText = lowRung ? money(lowRung.strike) : '–';
  const highText = highRung ? money(highRung.strike) : '–';
  // What the two orders do, said once per screen: on the ticket where there is room for it, and under the payoff table on a
  // phone (range.css), which follows the ticket there. A Range's line needs the numbers of a bet; there are none while bets are
  // switched off or no stake can be placed.
  const pays = out ? `Wins if it finishes below ${lowText} or at ${highText} and above.` : figures && !venue.readOnly ? rangeComesBack(usd(figures.contracts), usd(figures.cost)) : null;
  // What a screen reader is told as things change: the outcome of an attempt, a bet that may or may not have been placed and a
  // refusal's reason, once, and never a price tick. A market that is shut is said by its button's label, so the note read out is
  // that and what to do about it.
  const spoken =
    phase === 'placed' && bet
      ? landingWords(bet).spoken
      : unsure
        ? 'We could not confirm this bet. Check My bets before you try again.'
        : !error && state.notice && state.notice.tone !== 'bad'
          ? market
            ? `${market.label}. ${state.notice.text}`
            : state.notice.text
          : '';
  const locked = phase !== 'idle';

  // When the button that was pressed is disabled by what happened, focus goes to the note that says so, not to the page's top.
  const errorNote = useRef<HTMLParagraphElement>(null);
  const unsureNote = useRef<HTMLParagraphElement>(null);
  useRescueFocus(errorNote, !!error);
  useRescueFocus(unsureNote, unsure);

  // What the market has to say about the bet, in the one place a person is looking: above the figures when it has closed (the
  // numbers are then the last ones it showed), under the stake box otherwise.
  const note = error ? (
    <p className="note note-bad" role="alert" ref={errorNote} tabIndex={-1}>
      {error}
    </p>
  ) : state.notice ? (
    <p className={`note note-${state.notice.tone}`} role={state.notice.tone === 'bad' ? 'alert' : undefined}>
      {state.notice.text}
    </p>
  ) : null;

  // On a phone the ticket is a long way below the chart, so its button rides along the bottom of the window (components/PlaceBar).
  const phone = usePhone();
  const showBar = phone && phase !== 'placed' && !!event && priced;
  const placeButton = (
    <button type="button" className="btn btn-primary btn-wide" disabled={!canPlace} onClick={place}>
      {phase === 'placing' ? <span className="spin" aria-hidden="true" /> : null}
      {stale && state.canPlace ? 'Checking the price' : state.label}
    </button>
  );

  return (
    <div className="page builder range-page">
      <header className="page-head">
        <div>
          <h1 className="h-page">{words.title}</h1>
          <p className="lede">{words.lede}</p>
        </div>
        <HowItWorks kind='range' />
      </header>

      {markets.error && !markets.data && (
        <div className="card notice" role="alert">
          <b>We could not load the markets.</b>
          <span>{friendly(markets.error)}</span>
          <button type="button" className="btn btn-ghost" onClick={markets.reload}>
            Try again
          </button>
        </div>
      )}

      {unlisted && (
        <p className="note note-info deep-link-note">
          That market is no longer listed.{event ? ` Showing ${assetLabel(event)} instead.` : ''} <Link to={keepMode('/markets')}>See all markets</Link>
        </p>
      )}

      {!loadingFirst && !event ? (
        // Nothing to pick from: the markets did not load (said above) or none is open. There is no chart or ticket to build.
        !markets.error && (
          <section className="card">
            <div className="empty">No markets are open right now. Check back in a few minutes.</div>
          </section>
        )
      ) : event && !priced ? (
        <section className="card chart-card">
          <MarketPicker
            events={events}
            event={event}
            onPick={pick}
            unpriced={ladders.unpriced.length}
            showUnpriced={showUnpriced}
            onToggleUnpriced={() => setShowUnpriced((v) => !v)}
            now={clock}
          />
          <div className="empty">No prices on this market right now. Pick another asset or check back in a few minutes.</div>
        </section>
      ) : (
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
                loading={loadingFirst}
                disabled={locked}
              />
              <div className="direction" role="radiogroup" aria-label="Which side of the two levels the bet takes" onKeyDown={(e) => rovingKeys(e, { choose: true })}>
                <span className="eyebrow">Bet that the price</span>
                <div className="switch">
                  {(
                    [
                      ['in', 'Stays between'],
                      ['out', 'Breaks out'],
                    ] as const
                  ).map(([s, label]) => (
                    <button key={s} type="button" role="radio" aria-checked={side === s} tabIndex={side === s ? 0 : -1} className={side === s ? 'is-on' : ''} onClick={() => turn(s)} disabled={locked}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="chart-hint">
                {phase === 'placed'
                  ? // A bet that is not on the books (nothing bought, or sold back at once) was only tried.
                    bet && (landingOf(bet) === 'placed' || landingOf(bet) === 'unprotected')
                    ? 'This chart shows the bet you placed.'
                    : 'This chart shows the bet you tried to place.'
                  : closed
                    ? // The button says the market has closed; this only says what the chart is.
                      'These are the last prices it showed.'
                    : 'Drag the markers or tap the chart to set the lower and higher levels.'}
              </p>
              {loadingFirst || !sel ? (
                <div className="skeleton chart-skel" />
              ) : (
                // A placed bet's chart is a record, and so is a market that has closed: there is nothing left to choose on it.
                <div className={phase === 'placed' || closed ? 'chart-locked' : undefined}>
                  <LadderChart
                    rungs={event!.rungs}
                    condition={sel.low}
                    target={sel.high}
                    mode={out ? 'breakout' : 'range'}
                    locked={phase === 'placed' || closed}
                    onChange={(low, high) => phase !== 'placed' && !closed && setSel({ low, high })}
                  />
                </div>
              )}
              <ChartKey />
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
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sentence.outcomes.map((o) => (
                    <tr key={o.kind} data-kind={o.kind}>
                      <td>
                        <i aria-hidden="true" />
                        {both ? o.label : '–'}
                      </td>
                      <td className="n">{shares && o.kind !== 'back' ? `${shares[o.kind]}%` : '–'}</td>
                      <td className="n">{amount(o.kind)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* On a phone this line stands in for the one on the ticket (range.css), so each screen says it once. The receipt says it once placed. */}
              {pays && phase !== 'placed' && <p className="fine rg-always">{pays}</p>}
            </section>

            {event && lowRung && highRung && (
              <DistCard rungs={event.rungs} shape={{ kind: out ? 'breakout' : 'range', low: lowRung.strike, high: highRung.strike }} zones={shares ? [shares.below, shares.between, shares.above] : null} />
            )}

          </div>

          <aside className={`card quote-card${refusing ? ' is-off' : ''}`}>
            {/* The one thing a screen reader is told as the ticket changes. The ticket itself is not a live region: it would read out
                every price tick and every keystroke in the stake box. */}
            <p className="sr-only" role="status">
              {spoken}
            </p>
            {phase === 'placed' && bet ? (
              <Receipt bet={bet} call={call} callError={callError} onAgain={again} onRetryCall={sealAgain} />
            ) : (
              <>
                <div className="q-title">
                  {/* The asset and the close in the viewer's own time, like the picker. The exchange's title (its hour is New York's) is the tooltip. */}
                  <span className="eyebrow" title={event?.title}>
                    {/* A market that has closed is said to have by its button; its heading is then only its name. */}
                    {event ? (closed ? assetLabel(event) : marketHeading(event, clock)) : 'Loading'}
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

                {closed && note}

                {shares ? <RangeBar shares={shares} side={side} /> : state.notice ? null : <div className="skeleton bar-skel" />}

                <div className="rg-figures">
                  <dl className={`nums ${settling || closed ? 'is-est' : ''}`}>
                    <div>
                      <dt>Chance of winning</dt>
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
                      <dt>Sell back now per $100</dt>
                      <dd>{cashOut100 !== null ? usd(cashOut100, 0) : '–'}</dd>
                    </div>
                  </dl>
                  {pays && !closed && <p className="rg-pay">{pays}</p>}
                </div>

                {verdict === 'warn' && (!state.notice || state.blockedBy === 'readonly') && fair !== null && pricePaid !== null && pricePaid - fair >= 0.03 && (
                  <p className="note note-warn">
                    You pay {cents(pricePaid)} per $1 against a fair price of {cents(fair)}.
                  </p>
                )}

                <StakeField id="stake" text={stakeText} stake={stake} onText={setStakeText} max={cap} note={stakeNote} disabled={closed} />

                {!closed && note}
                {(holding || unsure) && (
                  <p className="note note-info" ref={unsureNote} tabIndex={-1}>
                    We could not confirm this bet. <Link to={keepMode('/bets')}>Check My bets</Link> before you try again.
                  </p>
                )}

                {!showBar && placeButton}
              </>
            )}
          </aside>

          {/* After the ticket, so the keyboard reaches it after the stake and the button, as a phone draws it. Beside the chart
              and the tables on a wide screen, in the left column (builder.css). */}
          {event && (
            <LadderTable
              rungs={event.rungs}
              picked={sel ? { [sel.low]: words.tags[0], [sel.high]: words.tags[1] } : {}}
              rowClass={(r) => (both && r.strike > lowRung!.strike && r.strike < highRung!.strike ? (out ? 'is-between' : 'is-inside') : undefined)}
            />
          )}

          {showBar && <PlaceBar chance={shares ? `${shares.win}%` : null}>{placeButton}</PlaceBar>}
        </div>
      )}
    </div>
  );
}
