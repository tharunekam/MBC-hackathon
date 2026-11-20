import { money } from '../lib/format';
import { useWidth } from '../lib/hooks';
import { spacedLabels } from '../lib/ladders';
import { closesLabel } from '../lib/markets';
import { alongOf, priceSpan, priceTicks, type OutlookPoint } from '../lib/outlook';

interface Props {
  points: OutlookPoint[];
  now: number;
  /** The closing time picked out, by its ladder's ticker. */
  selected: string | null;
  onSelect: (ticker: string) => void;
  /** The same chart in words, for a screen reader. */
  spoken: string;
}

/**
 * The market's view of one asset as a fan: time runs left to right from now to the furthest close, price runs up. The line
 * is the middle of the view at each close, the darker band holds an even chance and the lighter one four chances in five.
 *
 * The fan opens from a point at the left edge. The exchange's ladders say nothing about the price right now, so that point
 * is the middle of the soonest ladder: the nearest thing the prices give to "where it is", and the page says so.
 *
 * The picture is for sighted mouse and touch use; the row of closing-time buttons under it (in Outlook.tsx) is the control
 * a keyboard or a screen reader uses, so the SVG itself is hidden from them and described once in `spoken`.
 */
export default function OutlookChart({ points, now, selected, onSelect, spoken }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const height = 248;
  const pad = { left: 62, right: 18, top: 14, bottom: 30 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;

  const span = priceSpan(points);
  const last = points[points.length - 1];
  if (!span || !last) return <div className="ol-chart" ref={wrapRef} />;

  const xOf = (at: number) => pad.left + plotW * alongOf(at, now, last.at);
  const yOf = (price: number) => pad.top + plotH * (1 - (price - span.low) / (span.high - span.low));
  const start = { x: pad.left, y: yOf(points[0]!.middle) };

  /** A band as a closed shape: out along its top edge from the opening point, back along its bottom edge. */
  const shape = (pick: (p: OutlookPoint) => { low: number; high: number } | null): string | null => {
    const held = points.filter((p) => pick(p) !== null);
    if (held.length === 0) return null;
    const top = held.map((p) => `L${xOf(p.at).toFixed(1)},${yOf(pick(p)!.high).toFixed(1)}`);
    const bottom = [...held].reverse().map((p) => `L${xOf(p.at).toFixed(1)},${yOf(pick(p)!.low).toFixed(1)}`);
    return `M${start.x.toFixed(1)},${start.y.toFixed(1)}${top.join('')}${bottom.join('')}Z`;
  };
  const wide = shape((p) => p.wide);
  const even = shape((p) => p.even);
  const middle = `M${start.x.toFixed(1)},${start.y.toFixed(1)}${points.map((p) => `L${xOf(p.at).toFixed(1)},${yOf(p.middle).toFixed(1)}`).join('')}`;

  const xs = points.map((p) => xOf(p.at));
  const labelled = spacedLabels(xs, 76, 64);
  const ticks = priceTicks(span);
  // On a narrow chart the soonest close sits almost on the left edge, and its label would print over "Now".
  const nowFits = !points.some((p, i) => (labelled.has(i) || p.ticker === selected) && xs[i]! - pad.left < 72);

  return (
    <div className="ol-chart" ref={wrapRef} role="img" aria-label={spoken}>
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line className="lc-grid" x1={pad.left} x2={width - pad.right} y1={yOf(t)} y2={yOf(t)} />
              <text className="lc-ytick" x={pad.left - 10} y={yOf(t) + 4} textAnchor="end">
                {money(t)}
              </text>
            </g>
          ))}

          {wide && <path className="ol-wide" d={wide} />}
          {even && <path className="ol-even" d={even} />}
          <path className="ol-middle" d={middle} />
          <circle className="ol-start" cx={start.x} cy={start.y} r={3} />
          {nowFits && (
            <text className="lc-xtick" x={pad.left} y={height - 8} textAnchor="start">
              Now
            </text>
          )}

          {points.map((p, i) => {
            const x = xs[i]!;
            const on = p.ticker === selected;
            // Each close takes the strip of chart nearest to it, so a tap anywhere near a point picks it.
            const left = i === 0 ? pad.left + 12 : (xs[i - 1]! + x) / 2;
            const right = i === points.length - 1 ? width : (x + xs[i + 1]!) / 2;
            return (
              <g key={p.ticker} className={`ol-point${on ? ' is-on' : ''}`} onClick={() => onSelect(p.ticker)}>
                <rect className="ol-hit" x={left} y={pad.top} width={Math.max(0, right - left)} height={plotH + pad.bottom} />
                <line className="ol-stem" x1={x} x2={x} y1={yOf((p.wide ?? p.even)?.high ?? p.middle)} y2={yOf((p.wide ?? p.even)?.low ?? p.middle)} />
                {p.even && (
                  <>
                    <line className="ol-cap" x1={x - 5} x2={x + 5} y1={yOf(p.even.high)} y2={yOf(p.even.high)} />
                    <line className="ol-cap" x1={x - 5} x2={x + 5} y1={yOf(p.even.low)} y2={yOf(p.even.low)} />
                  </>
                )}
                <circle className="ol-dot" cx={x} cy={yOf(p.middle)} r={on ? 5.5 : 4} />
                {(labelled.has(i) || on) && (
                  <text className="lc-xtick ol-when" x={Math.min(x, width - 2)} y={height - 8} textAnchor={i === points.length - 1 ? 'end' : 'middle'}>
                    {closesLabel(p.expiry, now)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
