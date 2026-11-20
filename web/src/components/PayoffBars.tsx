import { bucketLabel } from '../lib/distribution';
import { money, pct, usdSigned } from '../lib/format';
import { useWidth } from '../lib/hooks';
import { spacedLabels } from '../lib/ladders';
import type { LadderCurve } from '../lib/payoffCurve';
import '../styles/dist.css';

interface Props {
  curve: LadderCurve;
  /** What the price is of, for a screen reader: "Bitcoin". */
  asset: string;
}

/**
 * What a set of bets on one ladder nets at each price it can finish at: a bar above the line where they end ahead, below it
 * where they end behind. The bars sit over the same edges as the histogram of the market's view (DistChart), so the two read
 * together: that one says how likely each bar is, this one what it would pay.
 */
export default function PayoffBars({ curve, asset }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const bars = curve.bars;
  const n = bars.length;
  // Room under the plot for two lines: the figure a bar below the line carries, then the prices along the bottom.
  const height = 188;
  const pad = { left: 46, right: 10, top: 16, bottom: 46 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / n;
  const gap = Math.min(4, slot * 0.14);

  // One scale both ways from the line, so a bar's length means the same above and below it.
  const reach = Math.max(Math.abs(curve.best), Math.abs(curve.worst), 0.01);
  const up = curve.best > 0 ? curve.best / reach : 0;
  const down = curve.worst < 0 ? -curve.worst / reach : 0;
  // The line sits where the tallest gain and the deepest loss both fit, and never right at an edge.
  const zeroAt = pad.top + plotH * Math.min(0.88, Math.max(0.12, up / Math.max(up + down, 1e-9)));
  const perDollar = Math.min((zeroAt - pad.top) / Math.max(curve.best, 1e-9), (pad.top + plotH - zeroAt) / Math.max(-curve.worst, 1e-9));
  const yOf = (net: number) => zeroAt - net * perDollar;
  const xOf = (i: number) => pad.left + i * slot;

  const edges = bars.slice(0, -1).map((_, i) => xOf(i + 1));
  const labelled = spacedLabels(edges, 64, 52);
  const showValues = slot >= 44;

  const spoken =
    `What these bets on ${asset} net at each finishing price. ` +
    bars.map((b) => `${bucketLabel(b.bucket)}: ${usdSigned(b.net)}, ${pct(b.bucket.chance)} chance`).join('. ') +
    '.';

  return (
    <div className="pv" ref={wrapRef} role="img" aria-label={spoken}>
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {curve.best > 0 && (
            <text className="lc-ytick" x={pad.left - 8} y={yOf(curve.best) + 4} textAnchor="end">
              {usdSigned(curve.best)}
            </text>
          )}
          {curve.worst < 0 && (
            <text className="lc-ytick" x={pad.left - 8} y={yOf(curve.worst) + 4} textAnchor="end">
              {usdSigned(curve.worst)}
            </text>
          )}

          {bars.map((b, i) => {
            const y = yOf(b.net);
            const top = Math.min(y, zeroAt);
            const tall = Math.max(2, Math.abs(y - zeroAt));
            const kind = b.net > 0.005 ? 'ahead' : b.net < -0.005 ? 'behind' : 'level';
            return (
              <g key={i} className="pv-slot" data-kind={kind}>
                <title>{`${bucketLabel(b.bucket)}: ${usdSigned(b.net)} (${pct(b.bucket.chance)} chance)`}</title>
                <rect className="dc-hit" x={xOf(i)} y={pad.top} width={slot} height={plotH} />
                <rect className="pv-bar" x={xOf(i) + gap / 2} y={kind === 'level' ? zeroAt - 1 : top} width={Math.max(1, slot - gap)} height={kind === 'level' ? 2 : tall} rx={2} />
                {showValues && kind !== 'level' && (
                  <text className="dc-value" x={xOf(i) + slot / 2} y={b.net > 0 ? y - 5 : y + 13} textAnchor="middle">
                    {usdSigned(b.net)}
                  </text>
                )}
              </g>
            );
          })}

          <line className="pv-zero" x1={pad.left} x2={width - pad.right} y1={zeroAt} y2={zeroAt} />

          {bars.slice(0, -1).map((b, i) =>
            labelled.has(i) && b.bucket.to !== null ? (
              <text key={i} className="lc-xtick" x={edges[i]} y={height - 8} textAnchor="middle">
                {money(b.bucket.to)}
              </text>
            ) : null,
          )}
        </svg>
      )}
    </div>
  );
}
