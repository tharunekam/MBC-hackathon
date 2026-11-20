import { bucketLabel, likeliest, zoneOf, type Bucket, type Distribution, type Shape } from '../lib/distribution';
import { money } from '../lib/format';
import { useWidth } from '../lib/hooks';
import { spacedLabels } from '../lib/ladders';
import { wholePercents } from '../lib/shares';
import '../styles/dist.css';

interface Props {
  dist: Distribution;
  /** A bet on this ladder. Each bar is then coloured by what the bet does if the price finishes there. */
  shape?: Shape;
  /**
   * The whole percent to print on each bar, when the card around the chart has shared them out to match its own figures
   * (lib/chances.ts). Without it the bars are rounded together here. Either way they add to exactly 100.
   */
  percents?: number[];
  /** A person's own view over the same bars, drawn as a line across them. */
  view?: Bucket[];
  /** What the bars are, for a screen reader. */
  label?: string;
}

/**
 * The ladder as a histogram: the market's chance of finishing between each pair of neighbouring prices.
 *
 * The bars are equally wide whatever the gap between rungs, because the two end bars have no far edge to measure ("below the
 * lowest rung", "the highest rung or more"). The prices under the chart sit on the edges between bars, where they belong.
 */
export default function DistChart({ dist, shape, percents, view, label }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const bars = dist.buckets;
  const n = bars.length;
  // Rounded as a set: nine bars rounded one by one added to 102% on screen.
  const shown = percents && percents.length === n ? percents : wholePercents(bars.map((b) => b.chance));
  const mineShown = view && view.length === n ? wholePercents(view.map((b) => b.chance)) : null;
  const height = width < 520 ? 190 : 216;
  const pad = { left: 38, right: 10, top: 22, bottom: 30 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / n;
  const gap = Math.min(4, slot * 0.14);

  // The scale tops out a little above the tallest bar, on a round tenth, so nothing touches the top of the plot.
  const tallest = Math.max(...bars.map((b) => b.chance), ...(view ?? []).map((b) => b.chance), 0.05);
  const top = Math.min(1, Math.ceil((tallest + 0.02) * 10) / 10);
  const yOf = (p: number) => pad.top + (1 - Math.min(p, top) / top) * plotH;
  const xOf = (i: number) => pad.left + i * slot;

  const edges = dist.levels.map((_, i) => xOf(i + 1));
  // Price labels are 12px: a gap under about 72px would let two of them touch.
  const labelled = spacedLabels(edges, 72, 60);
  const showValues = slot >= 34;

  // The view as one stepped line: flat across each bar, stepping at each edge.
  const steps = view && view.length === n ? view.map((b, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(b.chance).toFixed(1)}H${xOf(i + 1).toFixed(1)}`).join('') : '';

  const most = likeliest(bars);
  const spoken = label ?? `The market’s chance of finishing in each price band.${most ? ` Most likely: ${bucketLabel(most)}, ${shown[bars.indexOf(most)]}%.` : ''}`;

  return (
    <div className="dc" ref={wrapRef} role="img" aria-label={spoken}>
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {[0, top / 2, top].map((p) => (
            <g key={p}>
              <line className="lc-grid" x1={pad.left} x2={width - pad.right} y1={yOf(p)} y2={yOf(p)} />
              <text className="lc-ytick" x={pad.left - 8} y={yOf(p) + 4} textAnchor="end">
                {Math.round(p * 100)}%
              </text>
            </g>
          ))}

          {bars.map((b, i) => {
            const y = yOf(b.chance);
            return (
              <g key={i} className="dc-slot" data-zone={shape ? zoneOf(shape, b) : undefined}>
                <title>{`${bucketLabel(b)}: ${shown[i]}%${mineShown ? `, your view ${mineShown[i]}%` : ''}`}</title>
                <rect className="dc-hit" x={xOf(i)} y={pad.top} width={slot} height={plotH} />
                <rect className="dc-bar" x={xOf(i) + gap / 2} y={y} width={Math.max(1, slot - gap)} height={Math.max(1, pad.top + plotH - y)} rx={2} />
                {/* A bar too small for a whole point carries no figure: "0%" over a bar would be wrong, and the rest still add to 100. */}
                {showValues && shown[i]! > 0 && (
                  <text className="dc-value" x={xOf(i) + slot / 2} y={y - 6} textAnchor="middle">
                    {shown[i]}%
                  </text>
                )}
              </g>
            );
          })}

          {steps && <path className="dc-view" d={steps} />}

          {dist.levels.map((l, i) =>
            labelled.has(i) ? (
              <text key={l.symbol} className="lc-xtick" x={edges[i]} y={height - 9} textAnchor="middle">
                {money(l.strike)}
              </text>
            ) : null,
          )}
          {dist.levels.map((l, i) => (
            <line key={l.symbol} className="dc-edge" x1={edges[i]} x2={edges[i]} y1={pad.top + plotH} y2={pad.top + plotH + (labelled.has(i) ? 5 : 3)} />
          ))}
        </svg>
      )}
    </div>
  );
}
