import type { Rung } from '../api/types';
import { cents, money, pct } from '../lib/format';

interface Props {
  rungs: Rung[];
  /** The rungs the bet is built on, each with the name the page gives it ("First level", "Target", "Floor", "Ceiling"). */
  picked: Record<string, string>;
  /** A class for a row that is neither of those, for the rungs a range lies across. */
  rowClass?: (rung: Rung) => string | undefined;
}

/**
 * Every price a market lists, with its chance and its buy and sell prices. The chart and the histogram already draw these
 * numbers, so this third telling of them is folded away until someone asks for it: the page ends sooner, and the figures are
 * still one tap (or Enter) away. A native disclosure, so it is announced as collapsed or expanded without any script.
 */
export default function LadderTable({ rungs, picked, rowClass }: Props) {
  return (
    <details className="card rungs">
      <summary className="card-head">
        <h2 className="h-card">Every price in this market</h2>
        <span className="fine">With its chance, and what it costs to buy or sell</span>
      </summary>
      <table className="scen">
        <thead>
          <tr>
            <th scope="col">Price</th>
            <th scope="col" className="n">
              At or above
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
          {rungs.map((r) => {
            const mid = r.bid !== null && r.ask !== null ? (r.bid + r.ask) / 2 : null;
            // Halfway between a buy at 62¢ and a sell at 63¢ is 62.5%: said as it is, not rounded a second way.
            const half = mid !== null && Math.round(mid * 1000) % 10 !== 0;
            const tag = picked[r.symbol];
            return (
              <tr key={r.symbol} className={tag ? 'is-picked' : rowClass?.(r)}>
                <td>
                  {money(r.strike)}
                  {tag && <span className="tag">{tag}</span>}
                </td>
                <td className="n">{mid !== null ? pct(mid, half ? 1 : 0) : '–'}</td>
                <td className="n">{r.ask !== null ? cents(r.ask) : '–'}</td>
                <td className="n">{r.bid !== null ? cents(r.bid) : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
