import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { MarketEvent } from '../api/types';
import DistChart from '../components/DistChart';
import MarketPicker from '../components/MarketPicker';
import { distributionOf, marketView, viewBuckets, viewOf, type View } from '../lib/distribution';
import { cents, money, usd } from '../lib/format';
import { useNow, useResource } from '../lib/hooks';
import { builderLink, ideasOn, MIN_WIN, outOfOrder, rank, winsOn, type Idea } from '../lib/hunch';
import { listLadders, snap, tickFor } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { anotherOpen, marketNote, useNowAtClose, useOpeningNote, useReopenWatch } from '../lib/marketPhase';
import { assetLabel, marketHeading } from '../lib/markets';
import { chanceWords } from '../lib/together';
import { keepMode } from '../lib/venue';
import '../styles/builder.css';
import '../styles/hunch.css';

/** The stake the list's one dollar figure is worked for: small, round, and one of the builders' quick amounts. */
const EXAMPLE_STAKE = 10;

/** The bet as a sentence, with its prices picked out. The same words as the builders: a falling bet stays under its first level and falls below its target. */
function Sentence({ idea }: { idea: Idea }) {
  if (idea.product === 'range')
    return (
      <>
        Finishes between <em>{money(idea.low.strike)}</em> and <em>{money(idea.high.strike)}</em>
      </>
    );
  if (idea.product === 'breakout')
    return (
      <>
        Finishes outside <em>{money(idea.low.strike)}</em> to <em>{money(idea.high.strike)}</em>
      </>
    );
  return idea.direction === 'up' ? (
    <>
      Given <em>{money(idea.condition.strike)}</em> or above, reaches <em>{money(idea.target.strike)}</em>
    </>
  ) : (
    <>
      Given it stays under <em>{money(idea.condition.strike)}</em>, falls below <em>{money(idea.target.strike)}</em>
    </>
  );
}

const productName = (idea: Idea) => (idea.product === 'range' ? 'Range' : idea.product === 'breakout' ? 'Breakout' : idea.direction === 'up' ? 'Stake Back' : 'Stake Back, falling');

export default function Hunch() {
  const now = useNow(20000);
  const markets = useResource('markets', () => api.markets(), { live: [[execLive, 'markets']], pollMs: 4000, minGapMs: 800 });
  const ladders = useMemo(() => listLadders(markets.data?.events ?? []), [markets.data]);
  const events = ladders.shown;
  const feeCoef = markets.data?.feeCoefCharged ?? 0;

  const [params] = useSearchParams();
  const asked = params.get('market');
  const [ticker, setTicker] = useState<string | null>(asked);
  // A link to a market that is not listed says so, until the person picks one themselves.
  const [picked, setPicked] = useState(false);
  const event: MarketEvent | undefined = events.find((e) => e.ticker === ticker) ?? ladders.first;
  useEffect(() => {
    if (event && ticker !== event.ticker) setTicker(event.ticker);
  }, [event, ticker]);

  const dist = useMemo(() => (event ? distributionOf(event.rungs) : null), [event]);
  const base = useMemo(() => (dist ? marketView(dist.levels) : null), [dist]);

  // The person's view. Null until they move a dial: until then it is the market's own, and stays the market's as prices move.
  const [mine, setMine] = useState<View | null>(null);
  useEffect(() => setMine(null), [event?.ticker]);
  const view = mine ?? base;

  // A market that has closed, or is not trading yet, has no bet to offer, whatever its last prices say.
  const clock = Math.max(now, useNowAtClose(event?.expiry));
  const market = event ? marketNote(event, clock, { another: anotherOpen(events, event, clock) }) : null;
  // One that takes bets but is still opening gets a heads-up, said once for the whole list. The builders say it again.
  const opening = useOpeningNote(event, clock);

  const levels = dist?.levels;
  const chance = useMemo(() => (levels && view ? viewOf(levels, view) : null), [levels, view]);
  const bars = useMemo(() => (levels && chance ? viewBuckets(chance, levels) : undefined), [levels, chance]);
  const shut = market !== null;
  useReopenWatch(shut, markets.reload);
  const ideas = useMemo(() => (event && !shut ? ideasOn(event, feeCoef) : []), [event, feeCoef, shut]);
  // A ladder whose prices are out of order takes no bet, and says so rather than "no bets are on offer".
  const crossedLadder = !!event && outOfOrder(event);
  // A bet the exchange prices far above its fair value can still be listed, but never ahead of one that is fairly priced.
  const picks = useMemo(() => (mine && chance ? rank(ideas, chance, { limit: 5, perKind: 2 }).sort((a, b) => Number(a.idea.waived) - Number(b.idea.waived)) : []), [mine, chance, ideas]);
  // Nothing likelier was worth its price, so the list is the best of the long shots, and says so.
  const longShots = picks.length > 0 && picks.every((s) => s.win < MIN_WIN);

  const lo = levels?.[0]?.strike ?? 0;
  const hi = levels?.[levels.length - 1]?.strike ?? 1;
  const gap = levels && levels.length > 1 ? (hi - lo) / (levels.length - 1) : 1;
  const tick = tickFor(gap);
  const widest = base ? Math.max(base.spread * 3, gap * 3) : gap * 3;
  const narrowest = Math.max(tick, gap / 5);
  // The end of the track sits on a step, not on whatever three spreads happens to be.
  const widestStep = Math.max(narrowest, Math.floor(widest / tick + 1e-9) * tick);

  const loadingFirst = markets.loading && !markets.data;
  const askedGone = !!asked && !picked && !!markets.data && !events.some((e) => e.ticker === asked);
  const shift = view && base ? view.center - base.center : 0;
  const moved = !!mine && !!base && (Math.abs(shift) >= tick || Math.abs(mine.spread - base.spread) >= tick);

  return (
    <div className="page builder hunch">
      <header className="page-head">
        <div>
          <h1 className="h-page">Hunch</h1>
          <p className="lede">Say where you think the price finishes and how sure you are. We list the bets your view favors.</p>
        </div>
        <Link to={keepMode('/#how')} className="head-link">
          How it works
        </Link>
      </header>

      {askedGone && (
        <p className="note" role="status">
          That market is no longer listed. {event ? `Showing ${assetLabel(event)} instead.` : 'Pick another below.'} <Link to={keepMode('/markets')}>See all markets</Link>
        </p>
      )}

      {markets.error && !markets.data ? (
        // One state for the whole page: the list below it would only say a second, different thing about the same failure.
        <div className="card notice" role="alert">
          <b>The markets did not load</b>
          <span>Nothing about your bets has changed.</span>
          <button type="button" className="btn btn-ghost" onClick={markets.reload}>
            Try again
          </button>
        </div>
      ) : (
        <div className="build-grid">
          <div className="left-col">
            <section className="card chart-card" aria-busy={loadingFirst}>
              <MarketPicker events={events} event={event} onPick={(e) => (setPicked(true), setTicker(e.ticker))} unpriced={0} showUnpriced={false} onToggleUnpriced={() => {}} now={clock} />
              <p className="chart-hint">Bars show the market’s chance of finishing in each price band. The line is your view.</p>
              {loadingFirst ? (
                <div className="skeleton chart-skel" />
              ) : dist && view && base ? (
                <>
                  <div className="hunch-chart">
                    <DistChart dist={dist} view={bars} label="The market’s chance of finishing in each price band, with your view drawn over it." />
                  </div>
                  <div className="dist-keys">
                    <span>
                      <i /> The market
                    </span>
                    <span data-kind="view">
                      <i /> Your view
                    </span>
                  </div>

                  <div className="hunch-dials">
                    <div className="hunch-dial">
                      <label htmlFor="hunch-center">
                        Where you think it finishes <span className="dial-value" aria-hidden="true">{money(snap(view.center, tick))}</span>
                      </label>
                      <input
                        id="hunch-center"
                        type="range"
                        min={lo - gap}
                        max={hi + gap}
                        step={tick}
                        value={view.center}
                        aria-valuetext={money(snap(view.center, tick))}
                        onChange={(e) => setMine({ center: Number(e.target.value), spread: view.spread })}
                      />
                      <span className="fine">
                        <span>{money(lo - gap)}</span>
                        <span>{money(hi + gap)}</span>
                      </span>
                    </div>
                    <div className="hunch-dial">
                      <label htmlFor="hunch-spread">
                        Give or take <span className="dial-value" aria-hidden="true">±{money(snap(view.spread, tick))}</span>
                      </label>
                      <input
                        id="hunch-spread"
                        type="range"
                        min={narrowest}
                        max={widestStep}
                        step={tick}
                        value={Math.min(Math.max(view.spread, narrowest), widestStep)}
                        aria-valuetext={`plus or minus ${money(snap(view.spread, tick))}`}
                        onChange={(e) => setMine({ center: view.center, spread: Number(e.target.value) })}
                      />
                      <span className="fine">
                        <span>Very sure</span>
                        <span>Not sure</span>
                      </span>
                    </div>
                  </div>

                  <p className="hunch-say">
                    <span>
                      {moved ? (
                        <>
                          You: around <b>{money(snap(view.center, tick))}</b>, give or take <b>{money(snap(view.spread, tick))}</b>. The market: around <b>{money(snap(base.center, tick))}</b>, give or
                          take <b>{money(snap(base.spread, tick))}</b>.
                        </>
                      ) : (
                        <>
                          This is the market’s own view: around <b>{money(snap(base.center, tick))}</b>, give or take <b>{money(snap(base.spread, tick))}</b>. Move a dial to say where you differ.
                        </>
                      )}
                    </span>
                    <button type="button" className="hunch-reset" onClick={() => setMine(null)} disabled={!mine}>
                      Back to the market’s view
                    </button>
                  </p>
                </>
              ) : (
                <div className="empty">No market has prices right now. Check back in a few minutes.</div>
              )}
            </section>
          </div>

          <aside className="card hunch-list" aria-busy={loadingFirst}>
            {/* Said once when the list changes, not on every move of a dial or tick of a price. */}
            <p className="sr-only" role="status">
              {picks.length > 0 ? `${picks.length} ${picks.length === 1 ? 'bet fits' : 'bets fit'} your view` : ''}
            </p>
            <div className="q-title">
              {/* The asset and the close in the viewer's own time, like the picker. */}
              {event && <span className="eyebrow">{marketHeading(event, clock)}</span>}
              <h2 className="q-sentence">Bets that fit your view</h2>
            </div>

            {loadingFirst && <div className="skeleton hunch-skel" />}

            {opening && <p className="note note-warn hunch-long">{opening}</p>}
            {longShots && <p className="note note-warn hunch-long">These are long shots: each wins less than 1 time in 5.</p>}

            {picks.map((s) => {
              const costly = s.idea.waived;
              return (
                <article className="hunch-idea" key={builderLink(event!.ticker, s.idea)}>
                  <header>
                    <div>
                      <span className="eyebrow">{productName(s.idea)}</span>
                      <h3>
                        <Sentence idea={s.idea} />
                      </h3>
                    </div>
                    <Link className="btn btn-ghost btn-sm" to={keepMode(builderLink(event!.ticker, s.idea))}>
                      Open
                    </Link>
                  </header>
                  {/* Three figures. The first is what the bet is worth on the person's own view: it is not the builder's "Fair price
                      per $1", which is the market's, so it carries the person's name on it. The builder opens with the other one. */}
                  <dl className="hunch-figs">
                    <div>
                      <dt>Your fair price per $1</dt>
                      <dd>{s.worthCents}¢</dd>
                    </div>
                    <div>
                      <dt>You pay per $1</dt>
                      <dd>{s.priceCents}¢</dd>
                    </div>
                    {/* What the price pays, which is a fact. Not an average over the odds entered, which read as a promised return. */}
                    <div>
                      <dt>A {usd(EXAMPLE_STAKE, 0)} bet wins</dt>
                      <dd>{usd(winsOn(s.idea, EXAMPLE_STAKE))}</dd>
                    </div>
                  </dl>
                  <p className="hunch-view">On your view it wins {chanceWords(s.win)} of the time.</p>
                  {(costly || s.idea.warn) && (
                    <p className="note note-warn">
                      {costly ? 'Costs well over fair value' : 'Costs a little more than fair value'}: you pay {cents(s.idea.pricePaid)} per $1 against a fair price of {cents(s.idea.fairPrice)}.
                    </p>
                  )}
                </article>
              );
            })}

            {picks.length === 0 && !loadingFirst && (
              <p className="hunch-none">
                {!dist
                  ? 'Choose a market with prices to begin.'
                  : market
                    ? // Closed, or not trading yet: said as that, not as a market whose prices are too far apart.
                      `${market.text}${market.phase === 'closed' ? ' The chart shows its last prices.' : ''}`
                    : crossedLadder
                      ? 'The prices on this market are out of order for the moment, so no bet is offered. Check back in a minute, or pick another market.'
                      : ideas.length === 0
                        ? 'No bets are on offer in this market right now. The chart still shows where the market stands.'
                        : !moved
                          ? 'Your view is the market’s, so nothing beats its price yet. Move a dial to see bets that fit.'
                          : 'No bet beats its price on your view yet. Try moving a dial further from the market’s.'}
              </p>
            )}

            <p className="hunch-foot">These figures use your odds, not a forecast. Any bet can lose the stake.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
