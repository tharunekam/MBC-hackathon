import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { MarketEvent } from '../api/types';
import MarketPicker from '../components/MarketPicker';
import { bucketLabel, distributionOf, type Distribution } from '../lib/distribution';
import { money, usd, usdSigned } from '../lib/format';
import { useNow, useResource, useWidth } from '../lib/hooks';
import { listLadders, spacedLabels } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { anotherOpen, marketNote, openingNote, useNowAtClose, useReopenWatch } from '../lib/marketPhase';
import { marketHeading } from '../lib/markets';
import { wholePercents } from '../lib/shares';
import { handoverLink, MAX_PAY, orderText, PRESETS, presetShape, sketchOf, whereText, type Handover, type PresetId } from '../lib/sketch';
import '../styles/builder.css';
import '../styles/dist.css';
import '../styles/sketch.css';

/** The bar below the lowest level has no level under it to be known by. */
const LOWEST = '';

interface ChartProps {
  dist: Distribution;
  /** Dollars asked for in each bar, lowest prices first. */
  wanted: number[];
  /** The market's chance of each bar as a whole percent. They add to 100. */
  percents: number[];
  onSet: (bar: number, dollars: number) => void;
}

/**
 * One column per bar of the ladder. Behind, faint, the market's chance of finishing there, as the histogram on the other pages
 * draws it. In front, solid, what the person wants to receive there.
 *
 * The chart has one scale, dollars, because the solid bars are what is being set. The market's bars carry their own figure
 * under each column instead of a second scale beside the plot. The sliders under the chart are the controls; drawing on the
 * plot with a mouse or a pen sets the same amounts, and a finger is left to scroll the page.
 */
function SketchChart({ dist, wanted, percents, onSet }: ChartProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const drawing = useRef(false);
  const bars = dist.buckets;
  const n = bars.length;
  const height = width < 520 ? 204 : 232;
  // Two lines under the plot: the market's chance of each bar, then the prices on the edges between bars.
  const pad = { left: 38, right: 10, top: 20, bottom: 44 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const base = pad.top + plotH;
  const slot = plotW / n;
  const gap = Math.min(4, slot * 0.14);
  const xOf = (i: number) => pad.left + i * slot;
  const yOf = (dollars: number) => base - (Math.min(Math.max(dollars, 0), MAX_PAY) / MAX_PAY) * plotH;

  // The market's bars keep the histogram's own proportions: the tallest stops a little short of the top of the plot.
  const tallest = Math.max(...bars.map((b) => b.chance), 0.05);
  const top = Math.min(1, Math.ceil((tallest + 0.02) * 10) / 10);
  const tallOf = (chance: number) => Math.max(1, (Math.min(chance, top) / top) * plotH);

  const payW = Math.max(4, Math.min(slot - gap - 6, slot * 0.46));
  const edges = dist.levels.map((_, i) => xOf(i + 1));
  const labelled = spacedLabels(edges, 64, 52);
  const showFigures = slot >= 26;

  const place = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const bar = Math.floor((e.clientX - box.left - pad.left) / slot);
    if (bar < 0 || bar >= n) return;
    const dollars = Math.round(((base - (e.clientY - box.top)) / plotH) * MAX_PAY);
    onSet(bar, Math.min(MAX_PAY, Math.max(0, dollars)));
  };
  const stop = () => {
    drawing.current = false;
  };

  return (
    <div className="sk-chart" ref={wrapRef} role="img" aria-label="What you set to receive in each price range, drawn over the market’s chance of finishing there. The sliders under the chart set each amount and read it out.">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          onPointerDown={(e) => {
            if (e.pointerType === 'touch' || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            place(e);
          }}
          onPointerMove={(e) => {
            if (drawing.current) place(e);
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
        >
          {[0, MAX_PAY / 2, MAX_PAY].map((d) => (
            <g key={d}>
              <line className="lc-grid" x1={pad.left} x2={width - pad.right} y1={yOf(d)} y2={yOf(d)} />
              <text className="lc-ytick" x={pad.left - 8} y={yOf(d) + 4} textAnchor="end">
                {usd(d, 0)}
              </text>
            </g>
          ))}

          {bars.map((b, i) => {
            const want = wanted[i] ?? 0;
            const tall = tallOf(b.chance);
            return (
              <g key={i} className="dc-slot sk-slot">
                <title>{`${bucketLabel(b)}: you receive ${usd(want, 0)}. The market’s chance: ${percents[i]}%.`}</title>
                <rect className="dc-hit" x={xOf(i)} y={pad.top} width={slot} height={plotH} />
                <rect className="dc-bar" x={xOf(i) + gap / 2} y={base - tall} width={Math.max(1, slot - gap)} height={tall} rx={2} />
                {want > 0 && <rect className="sk-pay" x={xOf(i) + (slot - payW) / 2} y={yOf(want)} width={payW} height={Math.max(2, base - yOf(want))} rx={2} />}
                {showFigures && want > 0 && (
                  <text className="sk-amount" x={xOf(i) + slot / 2} y={yOf(want) - 5} textAnchor="middle">
                    {usd(want, 0)}
                  </text>
                )}
                {/* A bar too small for a whole point carries no figure, as on the histogram: "0%" under a bar would be wrong. */}
                {showFigures && percents[i]! > 0 && (
                  <text className="dc-value" x={xOf(i) + slot / 2} y={base + 15} textAnchor="middle">
                    {percents[i]}%
                  </text>
                )}
              </g>
            );
          })}

          {dist.levels.map((l, i) =>
            labelled.has(i) ? (
              <text key={l.symbol} className="lc-xtick" x={edges[i]} y={height - 7} textAnchor="middle">
                {money(l.strike)}
              </text>
            ) : null,
          )}
          {dist.levels.map((l, i) => (
            <line key={l.symbol} className="dc-edge" x1={edges[i]} x2={edges[i]} y1={base} y2={base + (labelled.has(i) ? 5 : 3)} />
          ))}
        </svg>
      )}
    </div>
  );
}

const PRODUCT_NAME = { range: 'Range', breakout: 'Breakout', parlay: 'Return Parlay' } as const;

/** What can be done with the shape: open the builder that places it, or the plain reason no builder does. */
function HandoverNote({ handover, link }: { handover: Handover; link: string | null }) {
  if (handover.kind === 'none') return null;
  if ((handover.kind === 'range' || handover.kind === 'breakout' || handover.kind === 'parlay') && link) {
    const name = PRODUCT_NAME[handover.kind];
    return (
      <div className="sk-hand">
        <p>
          {handover.kind === 'range' ? (
            <>
              This shape is a <b>Range</b>: it pays between <em>{money(handover.low.strike)}</em> and <em>{money(handover.high.strike)}</em>.
            </>
          ) : handover.kind === 'breakout' ? (
            <>
              This shape is a <b>Breakout</b>: it pays outside <em>{money(handover.low.strike)}</em> to <em>{money(handover.high.strike)}</em>.
            </>
          ) : handover.direction === 'up' ? (
            <>
              This shape is in the <b>Return Parlay</b> family: given <em>{money(handover.condition.strike)}</em> or above, reaches <em>{money(handover.target.strike)}</em>.
            </>
          ) : (
            <>
              This shape is in the <b>Return Parlay</b> family, falling: given it stays under <em>{money(handover.condition.strike)}</em>, falls below <em>{money(handover.target.strike)}</em>.
            </>
          )}
        </p>
        <Link className="btn btn-primary btn-wide" to={link}>
          Open as a {name}
        </Link>
        <p className="fine">The builder sizes the bet from a stake, so its amounts can differ from the sketch.</p>
      </div>
    );
  }
  return (
    <div className="sk-hand">
      <p>
        {handover.kind === 'single'
          ? 'This shape is one plain contract, which Given does not sell on its own. It is priced here and cannot be placed from Given.'
          : handover.kind === 'other' && handover.orders > 2
            ? `Given places two-order shapes today; this one needs ${handover.orders} orders, so it is priced here and cannot be placed yet.`
            : 'Given places three two-order shapes today: a Range, a Breakout and a Return Parlay. These two orders are not one of them, so this shape is priced here and cannot be placed yet.'}
      </p>
    </div>
  );
}

export default function Sketch() {
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

  // What the person asked for, kept by the level at each bar's lower edge and not by the bar's place in the row. A level that
  // loses its prices for a moment then merges two bars without shifting every amount above it one bar along.
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  useEffect(() => setAmounts({}), [event?.ticker]);
  const keys = useMemo(() => (dist ? [LOWEST, ...dist.levels.map((l) => l.symbol)] : []), [dist]);
  const wanted = keys.map((k) => amounts[k] ?? 0);
  const setBar = (bar: number, dollars: number) => {
    const key = keys[bar];
    if (key === undefined) return;
    setAmounts((was) => ((was[key] ?? 0) === dollars ? was : { ...was, [key]: dollars }));
  };
  const startFrom = (id: PresetId) => {
    if (!dist) return;
    const shape = presetShape(id, dist.levels);
    setAmounts(Object.fromEntries(keys.map((k, b) => [k, shape[b] ?? 0])));
  };

  // A market that has closed, or is not trading yet, has no orders to price, whatever its last prices say.
  const clock = Math.max(now, useNowAtClose(event?.expiry));
  const market = event ? marketNote(event, clock, { another: anotherOpen(events, event, clock) }) : null;
  // One that takes bets but is still opening gets the same heads-up the builders give.
  const opening = event ? openingNote(event, clock) : null;
  const shut = market !== null;
  useReopenWatch(shut, markets.reload);

  const sketch = event && dist && !shut ? sketchOf(event.rungs, wanted, feeCoef) : null;
  const priced = sketch && !sketch.flat ? sketch : null;
  const percents = dist ? wholePercents(dist.buckets.map((b) => b.chance)) : [];
  const anySet = wanted.some((w) => w > 0);
  // The shape to start from that the bars match right now, if any, so its button reads as chosen.
  const matching = dist && anySet ? PRESETS.find((p) => p.id !== 'clear' && presetShape(p.id, dist.levels).every((x, b) => x === wanted[b]))?.id : undefined;

  // Read out after the person changes the shape, and not each time the exchange's prices move a cent.
  const summary = priced ? `You pay ${usd(priced.pay)} now. At risk: ${usd(priced.atRisk)}.` : anySet && sketch?.flat ? 'Every price pays the same, so there is nothing to buy.' : '';
  const latest = useRef(summary);
  latest.current = summary;
  const [said, setSaid] = useState('');
  useEffect(() => setSaid(latest.current), [amounts]);

  const loadingFirst = markets.loading && !markets.data;

  return (
    <div className="page builder sketch">
      <header className="page-head">
        <div>
          <span className="eyebrow">Any shape, priced from the ladder</span>
          <h1 className="h-page">Sketch</h1>
          <p className="lede">Set what you want to receive at each finishing price. The page works out the orders that pay exactly that, and what they cost at the exchange’s prices.</p>
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
            <p className="chart-hint">
              The faint bars are the market’s chance of finishing between each two neighbouring prices. The solid bars are what you want to receive there.
              <span className="hint-more"> Set them with the sliders, or draw on the chart with a mouse.</span>
            </p>
            {loadingFirst ? (
              <div className="skeleton chart-skel" />
            ) : dist ? (
              <>
                <div className="sk-presets" role="group" aria-label="Shapes to start from">
                  {PRESETS.map((p) =>
                    p.id === 'clear' ? (
                      <button key={p.id} type="button" className="chip sk-clear" onClick={() => startFrom(p.id)} disabled={!anySet}>
                        {p.name}
                      </button>
                    ) : (
                      <button key={p.id} type="button" className={`chip${matching === p.id ? ' is-on' : ''}`} aria-pressed={matching === p.id} onClick={() => startFrom(p.id)}>
                        {p.name}
                      </button>
                    ),
                  )}
                </div>

                <SketchChart dist={dist} wanted={wanted} percents={percents} onSet={setBar} />
                <div className="dist-keys">
                  <span>
                    <i /> The market’s chance
                  </span>
                  <span data-kind="pay">
                    <i /> What you receive
                  </span>
                  {dist.adjusted && <span>Some prices were out of order and have been evened out.</span>}
                </div>

                <ol className="sk-rows" aria-label="What you receive in each price range">
                  {dist.buckets.map((b, i) => {
                    const want = wanted[i] ?? 0;
                    return (
                      <li className="sk-row" key={keys[i]}>
                        <span className="sk-where">
                          <label htmlFor={`sk-bar-${i}`}>{bucketLabel(b)}</label>
                          <small id={`sk-odds-${i}`}>{percents[i]}% chance</small>
                        </span>
                        <input
                          id={`sk-bar-${i}`}
                          type="range"
                          min={0}
                          max={MAX_PAY}
                          step={1}
                          value={want}
                          aria-valuetext={`${want} ${want === 1 ? 'dollar' : 'dollars'}`}
                          aria-describedby={`sk-odds-${i}`}
                          onChange={(e) => setBar(i, Number(e.target.value))}
                        />
                        <output htmlFor={`sk-bar-${i}`}>{usd(want, 0)}</output>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <div className="empty">No market has prices right now. Check back in a few minutes.</div>
            )}
          </section>
        </div>

        <aside className="card sk-result">
          <div className="q-title">
            {/* The asset and the close in the viewer's own time, like the picker. The exchange's title (its hour is New York's) is the tooltip. */}
            <span className="eyebrow" title={event?.title}>
              {event ? marketHeading(event, clock) : 'Loading'}
            </span>
            <h2 className="q-sentence">What this shape costs</h2>
          </div>
          <p className="sr-only" role="status">
            {said}
          </p>

          {opening && <p className="note note-warn sk-note">{opening}</p>}

          {priced && dist ? (
            <>
              {priced.floor > 0 && (
                <p className="note note-warn sk-note">
                  You asked for at least {usd(priced.floor, 0)} at every price. No order is needed for that part, because it is money you keep. The figures are for what you receive on top of it.
                </p>
              )}
              <dl className="sk-figs">
                <div>
                  <dt>You pay now</dt>
                  <dd>{usd(priced.pay)}</dd>
                </div>
                {priced.back > 0.004 && (
                  <div>
                    <dt>Comes back wherever it finishes</dt>
                    <dd>{usd(priced.back)}</dd>
                  </div>
                )}
                <div className="is-main">
                  <dt>At risk</dt>
                  <dd>{usd(priced.atRisk)}</dd>
                </div>
                <div className="is-break">
                  <dt>Worth at the market’s odds</dt>
                  <dd>{usd(priced.fair)}</dd>
                </div>
                <div>
                  <dt>Costs over the market’s odds</dt>
                  <dd>{usd(Math.abs(priced.over) < 0.005 ? 0 : priced.over)}</dd>
                </div>
                <div>
                  <dt>Chance of ending ahead</dt>
                  <dd>{Math.round(priced.chanceAhead * 100)}%</dd>
                </div>
                <div className="is-break" data-kind={priced.best.net > 0.004 ? 'win' : priced.best.net < -0.004 ? 'lose' : undefined}>
                  <dt>
                    Best result
                    <small>{whereText(dist.buckets, priced.best.bars)}</small>
                  </dt>
                  <dd>{usdSigned(priced.best.net)}</dd>
                </div>
                <div data-kind={priced.worst.net < -0.004 ? 'lose' : undefined}>
                  <dt>
                    Worst result
                    <small>{whereText(dist.buckets, priced.worst.bars)}</small>
                  </dt>
                  <dd>{usdSigned(priced.worst.net)}</dd>
                </div>
              </dl>

              <h3 className="sk-sub">The orders</h3>
              <ol className="sk-orders">
                {priced.orders.map((o) => (
                  <li key={o.symbol}>
                    <span>{orderText(o)}</span>
                    <b>{usd(o.cost)}</b>
                  </li>
                ))}
                <li className="is-total">
                  <span>{priced.fees > 0.004 ? `Total, with ${usd(priced.fees)} in fees` : 'Total'}</span>
                  <b>{usd(priced.pay)}</b>
                </li>
              </ol>

              <HandoverNote handover={priced.handover} link={event ? handoverLink(event.ticker, priced.handover) : null} />
            </>
          ) : (
            <p className="sk-none">
              {!dist
                ? 'Choose a market with prices to begin.'
                : market
                  ? // Closed, or not trading yet: said as that, and nothing is priced from prices nobody can trade at.
                    `${market.text}${market.phase === 'closed' ? ' The chart shows its last prices.' : ''}`
                  : anySet
                    ? `You asked for the same ${usd(sketch?.floor ?? 0, 0)} at every price. That needs no order, because it is money you keep. Make one bar taller than another and the orders that pay the difference appear here.`
                    : 'Nothing yet: every price pays the same, so there is nothing to buy. Raise a bar, or start from one of the shapes above the chart, and the orders that pay it appear here.'}
            </p>
          )}

          <p className="sk-foot">Nothing is sent from this page. It works out the orders and prices them, and no order is placed from here.</p>
        </aside>
      </div>

      <p className="fine sk-now">These figures use the exchange’s prices right now and move with them.</p>
    </div>
  );
}
