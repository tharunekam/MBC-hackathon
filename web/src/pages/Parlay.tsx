import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Bet, CallRecord, Direction, MarketEvent, QuoteResponse, Rung } from '../api/types';
import LadderChart from '../components/LadderChart';
import MarketPicker from '../components/MarketPicker';
import ProbBar from '../components/ProbBar';
import Receipt from '../components/Receipt';
import StakeField from '../components/StakeField';
import { MIN_BET, buttonState } from '../lib/betState';
import { defaultPair } from '../lib/defaultPair';
import { cents, money, pct, usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useDebounced, useNow, useResource } from '../lib/hooks';
import { listLadders, shortTitle } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { estimate, mirrorBook, outcomesFor } from '../lib/pricing';
import { receiptWords } from '../lib/receiptWords';
import { useVenue } from '../lib/venue';
import '../styles/builder.css';

/** How each direction reads: the question on the ticket, the hint under the picker, and the names of the two levels. */
const WORDS = {
  up: {
    hint: 'Chance of finishing at or above each price. Drag the two markers, or tap the chart.',
    tags: ['Given', 'Reach'],
  },
  down: {
    hint: 'Chance of finishing at or above each price. Drag the two markers: the higher is the level to stay under, the lower the level to fall below.',
    tags: ['Stay under', 'Fall below'],
  },
} as const;

/** A rung as a bet going `direction` sees it: a falling bet reads the same contract from its NO side. */
const asSeen = (r: Rung, direction: Direction) => (direction === 'down' ? { ...r, ...mirrorBook(r) } : r);

/** Whether a pair of rungs is in the order the direction needs: the condition below the target going up, above it going down. */
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
  const [sel, setSel] = useState<{ c: string; t: string } | null>(null);
  const [stake, setStake] = useState(10);
  const [stakeText, setStakeText] = useState('10');

  const event: MarketEvent | undefined = events.find((e) => e.ticker === ticker) ?? ladders.first;

  // Start on the first event with a good default pair; reset when the hour rolls over and symbols disappear.
  useEffect(() => {
    if (!event) return;
    if (ticker !== event.ticker) setTicker(event.ticker);
    const c = sel && event.rungs.find((r) => r.symbol === sel.c);
    const t = sel && event.rungs.find((r) => r.symbol === sel.t);
    if (!c || !t || !inOrder(c, t, direction)) setSel(defaultPair(event, direction));
  }, [event, sel, ticker, direction]);

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
  // What to ask the executor, debounced as one snapshot of direction, ladder and pair: a switch of direction or ladder then
  // never sends the old pair to the new one. Empty until the pair is in the order the direction needs.
  const asked = event && sel && cRung && tRung && inOrder(cRung, tRung, direction) ? `${direction}|${event.ticker}|${sel.c}|${sel.t}` : '';
  const dAsked = useDebounced(asked, 200);
  const [dDirection, dTicker, dC, dT] = dAsked.split('|') as [Direction, string, string, string];
  // One cached answer per pair and stake: going back to a pair you looked at is instant, and prices that move refresh it.
  const quoteQ = useResource<QuoteResponse | null>(
    `quote:${dAsked}:${dStake}`,
    () => (dAsked ? api.quote({ event: dTicker, condition: dC, target: dT, stake: dStake, direction: dDirection }) : Promise.resolve(null)),
    { live: [[execLive, 'markets']], pollMs: 5000, minGapMs: 1500 },
  );
  const server = quoteQ.data && sel && quoteQ.data.condition.symbol === sel.c && quoteQ.data.target.symbol === sel.t ? quoteQ.data : null;
  // The button may rely on the executor's answer only when it is for this pair AND this stake, not one a moment ago.
  const current = !!server && dAsked === asked && dStake === stake;
  const settling = !server; // showing the estimate

  const offer = server?.quote;
  const chanceCondition = offer?.chanceCondition ?? est?.chanceCondition ?? null;
  const chanceBoth = offer?.chanceBothHappen ?? est?.chanceBothHappen ?? null;
  const fair = offer?.fairPrice ?? est?.fairPrice ?? null;
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
    ? { win: placedBet.payoffs.ifBothHit, lose: placedBet.payoffs.ifConditionOnly, cost: placedBet.cost }
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

  // A message about one pair must not outlive a change of pair or stake.
  useEffect(() => {
    setError(null);
  }, [sel?.c, sel?.t, stake, direction]);

  const state = buttonState({
    phase,
    readOnly: venue.readOnly,
    stake,
    direction,
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
      const res = await api.placeBet({ user: 'primary', event: event.ticker, condition: sel.c, target: sel.t, direction, stake });
      setBet(res.bet);
      setPhase('placed');
      api.commitCall(res.bet.id).then(setCall, (e) => setCallError(friendly(e)));
    } catch (e) {
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

  const setStakeFrom = (txt: string) => {
    setStakeText(txt);
    const n = Number(txt);
    if (Number.isFinite(n) && n > 0) setStake(Math.min(n, 100000));
  };

  const loadingFirst = markets.loading && !markets.data;
  const words = WORDS[direction];
  const sentence = receiptWords({ product: 'parlay', direction, condition: { symbol: '', label: '', strike: cRung?.strike ?? 0 }, target: { symbol: '', label: '', strike: tRung?.strike ?? 0 } });
  const chance = {
    win: chanceBoth,
    back: chanceCondition !== null ? 1 - chanceCondition : null,
    lose: chanceCondition !== null && chanceBoth !== null ? chanceCondition - chanceBoth : null,
  };

  return (
    <div className="page builder">
      <header className="page-head">
        <div>
          <span className="eyebrow">Refund if the first leg misses</span>
          <h1 className="h-page">Return Parlay</h1>
          <p className="lede">
            Bet that a price {direction === 'down' ? 'falls to a lower level' : 'reaches a higher level'}, given that it first {direction === 'down' ? 'stays under a higher one' : 'holds a lower one'}. If the first
            level fails, your stake comes back.
          </p>
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
            <p className="chart-hint">{phase === 'placed' ? 'Your bet, on the market’s chance of finishing at or above each price. Choose “Make another” to change it.' : words.hint}</p>
            {loadingFirst ? (
              <div className="skeleton chart-skel" />
            ) : event && sel ? (
              // Once the bet is placed the markers show that bet and stay put; "Make another" frees them again.
              <div className={phase === 'placed' ? 'chart-locked' : undefined}>
                <LadderChart rungs={event.rungs} condition={sel.c} target={sel.t} mode={direction} onChange={(c, t) => phase !== 'placed' && setSel({ c, t })} />
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
                    <td className="n">{chance[o.kind] !== null ? pct(chance[o.kind]!) : '–'}</td>
                    <td className="n">{!out ? '–' : o.kind === 'back' ? 'Stake back' : usdSigned(o.kind === 'win' ? out.win : out.lose)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

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
                    return (
                      <tr key={r.symbol} className={r.symbol === sel?.c || r.symbol === sel?.t ? 'is-picked' : undefined}>
                        <td>
                          {money(r.strike)}
                          {r.symbol === sel?.c && <span className="tag">{words.tags[0]}</span>}
                          {r.symbol === sel?.t && <span className="tag">{words.tags[1]}</span>}
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
                  {direction === 'down' ? (
                    <>
                      Given it stays below <em>{cRung ? money(cRung.strike) : '…'}</em>, will it fall below <em>{tRung ? money(tRung.strike) : '…'}</em>?
                    </>
                  ) : (
                    <>
                      Given <em>{cRung ? money(cRung.strike) : '…'}</em> or above, will it reach <em>{tRung ? money(tRung.strike) : '…'}</em>?
                    </>
                  )}
                </h2>
              </div>

              {chanceCondition !== null && chanceBoth !== null ? <ProbBar chanceCondition={chanceCondition} chanceBoth={chanceBoth} /> : <div className="skeleton bar-skel" />}

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

              <StakeField
                id="stake"
                text={stakeText}
                stake={stake}
                onText={setStakeFrom}
                note={
                  plan?.reduced && state.blockedBy !== 'thin'
                    ? `The market can only fill about ${usd(plan.cost)} at this price, so the bet will be that size.`
                    : depth && depth.maxStake >= 1
                      ? `Up to ${usd(depth.maxStake, 0)} fits right now.`
                      : `The two orders are sized so your stake comes back if the first ${direction === 'down' ? 'level fails' : 'part fails'}.`
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
