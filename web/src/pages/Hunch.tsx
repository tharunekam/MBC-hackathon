import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { MarketEvent } from '../api/types';
import DistChart from '../components/DistChart';
import MarketPicker from '../components/MarketPicker';
import { distributionOf, marketView, viewBuckets, viewOf, type View } from '../lib/distribution';
import { cents, money, usd } from '../lib/format';
import { useNow, useResource } from '../lib/hooks';
import { builderLink, ideasOn, MIN_WIN, rank, winsOn, type Idea } from '../lib/hunch';
import { listLadders, snap, tickFor } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { anotherOpen, marketNote, useNowAtClose, useReopenWatch } from '../lib/marketPhase';
import { marketHeading } from '../lib/markets';
import { wholePercents } from '../lib/shares';
import '../styles/builder.css';

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

const productName = (idea: Idea) => (idea.product === 'range' ? 'Range' : idea.product === 'breakout' ? 'Breakout' : idea.direction === 'up' ? 'Return Parlay' : 'Return Parlay, falling');

export default function Hunch() {
  const now = useNow(20000);
  const markets = useResource('markets', () => api.markets(), { live: [[execLive, 'markets']], pollMs: 4000, minGapMs: 800 });
  const ladders = useMemo(() => listLadders(markets.data?.events ?? []), [markets.data]);
  const events = ladders.shown;
  const feeCoef = markets.data?.feeCoefCharged ?? 0;

  const [params] = useSearchParams();
  const [ticker, setTicker] = useState<string | null>(params.get('market'));
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

  const levels = dist?.levels;
  const chance = useMemo(() => (levels && view ? viewOf(levels, view) : null), [levels, view]);
  const bars = useMemo(() => (levels && chance ? viewBuckets(chance, levels) : undefined), [levels, chance]);
  const shut = market !== null;
  useReopenWatch(shut, markets.reload);
  const ideas = useMemo(() => (event && !shut ? ideasOn(event, feeCoef) : []), [event, feeCoef, shut]);
  const picks = useMemo(() => (mine && chance ? rank(ideas, chance, { limit: 5, perKind: 2 }) : []), [mine, chance, ideas]);
  // Nothing likelier was worth its price, so the list is the best of the long shots, and says so.
  const longShots = picks.length > 0 && picks.every((s) => s.win < MIN_WIN);

  const lo = levels?.[0]?.strike ?? 0;
  const hi = levels?.[levels.length - 1]?.strike ?? 1;
  const gap = levels && levels.length > 1 ? (hi - lo) / (levels.length - 1) : 1;
  const tick = tickFor(gap);
  const widest = base ? Math.max(base.spread * 3, gap * 3) : gap * 3;
  const narrowest = Math.max(tick, gap / 5);

  const loadingFirst = markets.loading && !markets.data;
  const shift = view && base ? view.center - base.center : 0;
  const moved = !!mine && !!base && (Math.abs(shift) >= tick || Math.abs(mine.spread - base.spread) >= tick);

  return (
    <div className="page builder hunch">
      <header className="page-head">
        <div>
          <span className="eyebrow">Your view against the market’s</span>
          <h1 className="h-page">Hunch</h1>
          <p className="lede">Say where you think the price finishes and how sure you are. We list the bets on offer that are worth more to that view than they cost, biggest difference first.</p>
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
            <MarketPicker events={events} event={event} onPick={(e) => setTicker(e.ticker)} unpriced={0} showUnpriced={false} onToggleUnpriced={() => {}} now={clock} />
            <p className="chart-hint">The bars are the market’s chance of finishing between each two neighbouring prices, read from the exchange’s own prices. The line is your view.</p>
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
                  {dist.adjusted && <span>Some prices were out of order and have been evened out.</span>}
                </div>

                <div className="hunch-dials">
                  <div className="hunch-dial">
                    <label htmlFor="hunch-center">
                      Where you think it finishes <output>{money(snap(view.center, tick))}</output>
                    </label>
                    <input
                      id="hunch-center"
                      type="range"
                      min={lo - gap}
                      max={hi + gap}
                      step={tick}
                      value={view.center}
                      onChange={(e) => setMine({ center: Number(e.target.value), spread: view.spread })}
                    />
                    <span className="fine">
                      <span>{money(lo - gap)}</span>
                      <span>{money(hi + gap)}</span>
                    </span>
                  </div>
                  <div className="hunch-dial">
                    <label htmlFor="hunch-spread">
                      Give or take <output>± {money(snap(view.spread, tick))}</output>
                    </label>
                    <input
                      id="hunch-spread"
                      type="range"
                      min={narrowest}
                      max={widest}
                      step={tick}
                      value={Math.min(Math.max(view.spread, narrowest), widest)}
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
                  <button className="hunch-reset" onClick={() => setMine(null)} disabled={!mine}>
                    Back to the market’s view
                  </button>
                </p>
              </>
            ) : (
              <div className="empty">No market has prices right now. Check back in a few minutes.</div>
            )}
          </section>
        </div>

        <aside className="card hunch-list" aria-live="polite">
          <div className="q-title">
            {/* The asset and the close in the viewer's own time, like the picker. The exchange's title (its hour is New York's) is the tooltip. */}
            <span className="eyebrow" title={event?.title}>
              {event ? marketHeading(event, clock) : 'Loading'}
            </span>
            <h2 className="q-sentence">Bets that fit your view</h2>
          </div>

          {longShots && <p className="note note-warn hunch-long">Only long shots are worth more than they cost to this view. On your own odds, each wins less than one time in five.</p>}

          {picks.map((s) => {
            // Rounded together, so the two or three chances on a card add to 100.
            const [win, back, lose] = wholePercents([s.win, s.back, s.lose]);
            return (
              <article className="hunch-idea" key={builderLink(event!.ticker, s.idea)}>
                <header>
                  <div>
                    <span className="eyebrow">{productName(s.idea)}</span>
                    <h3>
                      <Sentence idea={s.idea} />
                    </h3>
                  </div>
                  <Link className="btn btn-ghost btn-sm" to={builderLink(event!.ticker, s.idea)}>
                    Open
                  </Link>
                </header>
                <dl className="hunch-figs">
                  <div>
                    <dt>Worth to you, per $1</dt>
                    <dd>{s.worthCents}¢</dd>
                  </div>
                  <div>
                    <dt>You pay per $1</dt>
                    <dd>{s.priceCents}¢</dd>
                  </div>
                  <div className="is-edge">
                    <dt>Difference</dt>
                    <dd>+{s.edgeCents}¢</dd>
                  </div>
                </dl>
                <p className="hunch-odds">
                  <span data-kind="win">
                    Win <b>{win}%</b>
                  </span>
                  {s.idea.product === 'parlay' && (
                    <span data-kind="back">
                      Stake back <b>{back}%</b>
                    </span>
                  )}
                  <span data-kind="lose">
                    Lose <b>{lose}%</b>
                  </span>
                </p>
                {/* What the price pays, which is a fact. Not an average over the odds entered, which read as a promised return. */}
                <p className="hunch-wins">
                  A {usd(EXAMPLE_STAKE, 0)} bet wins <b>{usd(winsOn(s.idea, EXAMPLE_STAKE))}</b> if you are right.
                </p>
                {(s.idea.waived || s.idea.warn) && (
                  <p className="note note-warn">
                    {s.idea.waived
                      ? `Costs well over fair value: ${cents(s.idea.pricePaid)} per $1 against a fair ${cents(s.idea.fairPrice)}. This is allowed on the sandbox only.`
                      : `Costs a little more than fair value: ${cents(s.idea.pricePaid)} per $1 against a fair ${cents(s.idea.fairPrice)}.`}
                  </p>
                )}
              </article>
            );
          })}

          {picks.length === 0 && (
            <p className="hunch-none">
              {!dist
                ? 'Choose a market with prices to begin.'
                : market
                  ? // Closed, or not trading yet: said as that, not as a market whose prices are too far apart.
                    `${market.text}${market.phase === 'closed' ? ' The chart shows its last prices.' : ''}`
                  : ideas.length === 0
                    ? 'No bet is on offer on this market right now. Usually that is because its buy and sell prices are too far apart to make a fair deal. The chart still shows where the market stands.'
                    : !moved
                      ? 'Nothing yet: your view is the market’s, and every bet costs a little more than the market thinks it is worth. Move a dial, and the bets your view makes worth more than they cost appear here.'
                      : 'No bet on this market is worth more to you than it costs right now. Your view is close to the market’s, or the spread costs more than the difference.'}
            </p>
          )}

          <p className="hunch-foot">
            These figures use the odds you entered, not a forecast of ours. The market’s prices come from people betting real money and they may be right. Every bet listed can lose the stake.
          </p>
        </aside>
      </div>
    </div>
  );
}
