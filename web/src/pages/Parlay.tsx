import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CallRecord, Direction, MarketEvent, PlaceParlayRequest, QuoteResponse, Rung } from '../api/types';
import DistCard from '../components/DistCard';
import LadderChart, { ChartKey } from '../components/LadderChart';
import LadderTable from '../components/LadderTable';
import MarketPicker from '../components/MarketPicker';
import PlaceBar, { usePhone, useRescueFocus } from '../components/PlaceBar';
import ProbBar from '../components/ProbBar';
import Receipt from '../components/Receipt';
import StakeField from '../components/StakeField';
import { MIN_BET, buttonState, isRefusal, maxPriceFor, stakeNote as stakeNoteFor } from '../lib/betState';
import { parlayPercents } from '../lib/chances';
import { kindOf } from '../lib/betKind';
import { defaultPair } from '../lib/defaultPair';
import { cents, money, usd, usdSigned } from '../lib/format';
import { friendly, sealProblem, type SealProblem } from '../lib/friendly';
import { useDebounced, useNow, useResource } from '../lib/hooks';
import { hasPrices, listLadders } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { anotherOpen, marketNote, useNowAtClose, useReopenWatch } from '../lib/marketPhase';
import { assetLabel, marketHeading } from '../lib/markets';
import { estimate, mirrorBook, outcomesFor } from '../lib/pricing';
import { landingOf, landingWords, receiptWords } from '../lib/receiptWords';
import { rovingKeys } from '../lib/roving';
import { stakeFrom, stakeRefusal, useStakeCap } from '../lib/stake';
import { mayHaveBeenPlaced, sameAttempt, useAttempts, useUnconfirmedBet } from '../lib/unconfirmedBet';
import { keepMode, useVenue } from '../lib/venue';
import '../styles/builder.css';

/**
 * How each direction reads. The two prices have one name each wherever they appear: the first level (the one that has to
 * hold) and the target (what the bet is about). A rising bet holds its first level and reaches its target; a falling one
 * stays under its first level and falls below its target. The lede defines both words before they are used.
 */
const WORDS = {
  up: {
    lede: 'Pick a first level and a target. Win if the price reaches the target. If it falls below the first level, you get your stake back.',
    markers: ' The lower marker is your first level and the higher is your target.',
  },
  down: {
    lede: 'Pick a first level and a target. Win if the price falls below the target. If it rises to the first level, you get your stake back.',
    markers: ' The higher marker is your first level and the lower is your target.',
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
  // Real exchanges list dozens of markets, most with no prices at a given moment. The picker offers the ones with prices;
  // the page opens on one you can bet on. The rest are a tap away, never hidden without saying so.
  const [showUnpriced, setShowUnpriced] = useState(false);
  const ladders = useMemo(() => listLadders(markets.data?.events ?? [], showUnpriced), [markets.data, showUnpriced]);
  const events = ladders.shown;

  // The Markets page links here with ?market=TICKER; a market with no prices is listed when that is the one asked for.
  const [params] = useSearchParams();
  const wanted = params.get('market');
  const [ticker, setTicker] = useState<string | null>(wanted);
  useEffect(() => {
    if (wanted && !showUnpriced && ladders.unpriced.some((e) => e.ticker === wanted)) setShowUnpriced(true);
  }, [wanted, showUnpriced, ladders.unpriced]);
  // A link to a market the exchange no longer lists opens on another one. It says so, until the person chooses for themselves.
  const [chose, setChose] = useState(false);
  const unlisted = !!wanted && !chose && !!markets.data && !markets.data.events.some((e) => e.ticker === wanted);

  const [direction, setDirection] = useState<Direction>(params.get('direction') === 'down' ? 'down' : 'up');
  // The Hunch page links here with a bet already chosen (?condition=&target=, the executor's names for the first level and
  // the target). If the market no longer has those two prices, or they are not in the order the direction needs, the effect
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
  // A market that lists prices but has none to bet on right now has no chart to draw and no bet to build.
  const priced = !!event && hasPrices(event);

  // Start on the first event with a good default; reset when the hour rolls over and symbols disappear.
  useEffect(() => {
    if (!event) return;
    if (ticker !== event.ticker) setTicker(event.ticker);
    const c = sel && event.rungs.find((r) => r.symbol === sel.c);
    const t = sel && event.rungs.find((r) => r.symbol === sel.t);
    if (!c || !t || !inOrder(c, t, direction)) setSel(defaultPair(event, direction));
  }, [event, sel, ticker, direction]);

  // A market that has closed, or is listed but not trading yet, cannot take a bet. Read on the second its close time passes,
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
  // What to ask the executor, debounced as one snapshot of direction, market and levels: a switch of direction or market then
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
  // The three chances as whole percents, worked out once. The bar, the figure under it, the table and the histogram all
  // print these, so they agree with each other and add to 100.
  const shares = chanceCondition !== null && chanceBoth !== null ? parlayPercents(direction, chanceCondition, chanceBoth) : null;

  // ------------------------------------------------------------------ place flow
  const [phase, setPhase] = useState<'idle' | 'placing' | 'placed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bet, setBet] = useState<Bet | null>(null);
  const [call, setCall] = useState<CallRecord | null>(null);
  const [callError, setCallError] = useState<SealProblem | null>(null);
  // When the last attempt was made, to recognise a bet that was placed although its answer never arrived.
  const attemptAt = useRef(0);
  // One id for each attempt: pressing Place bet again after an answer was lost sends the same id, so the executor places the bet
  // once whichever of the two requests got through. A new bet, a new stake or an answered attempt gets a new one.
  const attempts = useAttempts();
  // What the last attempt sent, and the price per $1 the person was shown when they pressed the button.
  const sent = useRef<{ req: PlaceParlayRequest; shown: number | null } | null>(null);
  // When the price moved out from under the person: the button waits for the quote to be read again after that, so the next press
  // is at the new price and not at the one that was just refused.
  const [movedAt, setMovedAt] = useState<number | null>(null);
  // Whether the last attempt may have been placed although no answer came. The hold on the button lasts ten seconds; this note
  // does not: it stays until the person presses again or changes the bet, because that is when they need to know to look.
  const [unsure, setUnsure] = useState(false);
  // One press at a time: the button is disabled once the page has re-rendered, but a press repeated within the same task (a
  // screen reader's activate, a script) gets here before that.
  const busy = useRef(false);

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

  // A bet that cannot be placed has no size and no winnings: the quote may still carry the figures of a bet nobody can make, and
  // they are neither shown as one ("On a $8.17 bet", "Win +$391.83") nor described as what the bet will be.
  const refusing = isRefusal(state);

  const plan = server?.stake;
  const depth = server?.depth && 'maxStake' in server.depth ? server.depth : null;
  const stakeOk = stake >= MIN_BET && (cap === null || stake <= cap);
  // Once a bet is placed the panel shows that bet's figures, which may be smaller than the stake that was asked for.
  const placedBet = phase === 'placed' ? bet : null;
  // Only a bet that is fully in place has results to tabulate; one that is not (see `landingOf`) has none to show.
  const hedgedBet = placedBet && landingOf(placedBet) === 'placed' ? placedBet : null;
  const out = hedgedBet?.payoffs
    ? { win: hedgedBet.payoffs.ifBothHit, lose: hedgedBet.payoffs.ifConditionOnly, cost: hedgedBet.cost }
    : placedBet && !hedgedBet
      ? null
      : !stakeOk || refusing
        ? null // no stake that could be placed, or a bet that is refused: no figures, rather than those of a bet nobody can make
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

  // A message about one bet must not outlive a change of levels or stake, nor the connection coming back.
  useEffect(() => {
    setError(null);
    setUnsure(false);
    setMovedAt(null);
  }, [sel?.c, sel?.t, stake, direction]);
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
    setError(friendly(e, { product: 'parlay', direction, shownPrice: shown }));
  }

  // After a dropped connection or a server error, the bet may have been placed anyway. The button is held while the list of
  // bets is read to find out, and once the same request is sent again under the same id: the executor places nothing twice for
  // one id, so that gives the bet that was placed, or places it now, but never two. The person is told where to look meanwhile.
  const [holding, setHolding] = useUnconfirmedBet(
    () => api.bets('primary').then((r) => r.bets),
    (b) =>
      sameAttempt(
        b,
        sent.current?.req.requestId ?? null,
        b.eventTicker === event?.ticker && b.condition.symbol === sel?.c && b.target.symbol === sel?.t && kindOf(b).product === 'parlay' && kindOf(b).direction === direction && Date.parse(b.createdAt) >= attemptAt.current - 3000,
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
    attemptAt.current = Date.now();
    setPhase('placing');
    setError(null);
    setUnsure(false);
    setCallError(null);
    // The price per $1 on the quote the button was built on: the bet may cost up to a little more than that, and no more.
    const shown = server?.quote.pricePaid ?? null;
    const maxPrice = maxPriceFor(shown);
    const req: PlaceParlayRequest = {
      user: 'primary',
      event: event.ticker,
      condition: sel.c,
      target: sel.t,
      direction,
      stake,
      ...(maxPrice !== undefined ? { maxPrice } : {}),
      requestId: attempts.idFor(`${event.ticker}|${sel.c}|${sel.t}|${direction}|${stake}`),
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
    setSel(defaultPair(e, direction));
    reset();
  }

  function turn(next: Direction) {
    if (next === direction) return;
    setDirection(next);
    setSel(event ? defaultPair(event, next) : null);
    reset();
  }

  const loadingFirst = markets.loading && !markets.data;
  const words = WORDS[direction];
  const sentence = receiptWords({ product: 'parlay', direction, condition: { symbol: '', label: '', strike: cRung?.strike ?? 0 }, target: { symbol: '', label: '', strike: tRung?.strike ?? 0 } });
  // The most a stake can be right now: what is on offer on the market, or the venue's cap on one bet if that is lower. Nothing is
  // said about a stake while bets are switched off: there is no bet to size.
  const fits = depth && depth.maxStake >= 1 ? Math.floor(depth.maxStake) : null;
  const stakeNote = stakeNoteFor({ readOnly: venue.readOnly, reducedTo: plan?.reduced ? plan.cost : null, refusing, cap, fits, at: 'this price', fallback: 'The two orders are sized so your stake comes back if the first level fails.' });
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
    <div className="page builder">
      <header className="page-head">
        <div>
          <h1 className="h-page">Stake Back</h1>
          <p className="lede">{words.lede}</p>
        </div>
        <Link to={keepMode('/#how')} className="head-link">
          How it works
        </Link>
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
              <div className="direction" role="radiogroup" aria-label="Which way the bet looks" onKeyDown={(e) => rovingKeys(e, { choose: true })}>
                <span className="eyebrow">Bet that the price</span>
                <div className="switch">
                  {(
                    [
                      ['up', 'Goes up'],
                      ['down', 'Goes down'],
                    ] as const
                  ).map(([d, label]) => (
                    <button key={d} type="button" role="radio" aria-checked={direction === d} tabIndex={direction === d ? 0 : -1} className={direction === d ? 'is-on' : ''} onClick={() => turn(d)} disabled={locked}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="chart-hint">
                {phase === 'placed' ? (
                  // A bet that is not on the books (nothing bought, or sold back at once) was only tried.
                  bet && (landingOf(bet) === 'placed' || landingOf(bet) === 'unprotected') ? (
                    'This chart shows the bet you placed.'
                  ) : (
                    'This chart shows the bet you tried to place.'
                  )
                ) : closed ? (
                  // The button says the market has closed; this only says what the chart is.
                  'These are the last prices it showed.'
                ) : (
                  <>
                    Drag the markers or tap the chart.<span className="hint-more">{words.markers}</span>
                  </>
                )}
              </p>
              {loadingFirst || !sel ? (
                <div className="skeleton chart-skel" />
              ) : (
                // Once the bet is placed the markers show that bet and stay put; "Make another" frees them again. A market that
                // has closed is a record too: there is nothing left to choose on it.
                <div className={phase === 'placed' || closed ? 'chart-locked' : undefined}>
                  <LadderChart
                    rungs={event!.rungs}
                    condition={sel.c}
                    target={sel.t}
                    mode={direction}
                    locked={phase === 'placed' || closed}
                    onChange={(c, t) => phase !== 'placed' && !closed && setSel({ c, t })}
                  />
                </div>
              )}
              <ChartKey />
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
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sentence.outcomes.map((o) => (
                    <tr key={o.kind} data-kind={o.kind}>
                      <td>
                        <i aria-hidden="true" />
                        {cRung && tRung ? o.label : '–'}
                      </td>
                      <td className="n">{shares ? `${shares[o.kind]}%` : '–'}</td>
                      <td className="n">{!out ? '–' : o.kind === 'back' ? 'Stake back' : usdSigned(o.kind === 'win' ? out.win : out.lose)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {event && cRung && tRung && <DistCard rungs={event.rungs} shape={{ kind: direction, condition: cRung.strike, target: tRung.strike }} zones={shares?.zones} />}

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
                    {direction === 'down' ? (
                      <>
                        Given it stays under <em>{cRung ? money(cRung.strike) : '–'}</em>, will it fall below <em>{tRung ? money(tRung.strike) : '–'}</em>?
                      </>
                    ) : (
                      <>
                        Given <em>{cRung ? money(cRung.strike) : '–'}</em> or above, will it reach <em>{tRung ? money(tRung.strike) : '–'}</em>?
                      </>
                    )}
                  </h2>
                </div>

                {closed && note}

                {chanceCondition !== null && chanceBoth !== null ? <ProbBar chanceCondition={chanceCondition} chanceBoth={chanceBoth} direction={direction} /> : state.notice ? null : <div className="skeleton bar-skel" />}

                <dl className={`nums ${settling || closed ? 'is-est' : ''}`}>
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
                    <dt>Sell back now per $100</dt>
                    <dd>{cashOut100 !== null ? usd(cashOut100, 0) : '–'}</dd>
                  </div>
                </dl>

                {verdict === 'warn' && (!state.notice || state.blockedBy === 'readonly') && fairShown !== null && pricePaid !== null && pricePaid - fairShown >= 0.03 && (
                  <p className="note note-warn">
                    You pay {cents(pricePaid)} per $1 against a fair price of {cents(fairShown)}.
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
          {event && <LadderTable rungs={event.rungs} picked={sel ? { [sel.c]: 'First level', [sel.t]: 'Target' } : {}} />}

          {showBar && <PlaceBar chance={shares ? `${shares.win}%` : null}>{placeButton}</PlaceBar>}
        </div>
      )}
    </div>
  );
}
