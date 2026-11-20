import type { Rung } from '../api/types';
import { cents, money, pct } from '../lib/format';

interface Props {
  rungs: Rung[];
  /** The prices the bet is built on, each with the name the page gives it ("First level", "Target", "Lower level", "Higher level"). */
  picked: Record<string, string>;
  /** A class for a row that is neither of those, for the rungs a range lies across. */
  rowClass?: (rung: Rung) => string | undefined;
}

/**
 * Every price a market lists, with its chance and its buy and sell prices. The chart and the histogram already draw these
 * numbers, so this third telling of them is folded away until someone asks for it: the page ends sooner, and the figures are
 * still one tap (or Enter) away. A native disclosure, so it is announced as collapsed or expanded without any script.
 *
 * The chance is a whole percent here as it is on the chart's labels, so the same price never reads 98.5% in one place and 99%
 * in another.
 */
export default function LadderTable({ rungs, picked, rowClass }: Props) {
  return (
    // Escape closes it and hands focus back to the summary, as it does for the phone's menu and the header's hint.
    <details
      className="card rungs"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !e.currentTarget.open) return;
        e.currentTarget.open = false;
        e.currentTarget.querySelector('summary')?.focus();
      }}
    >
      <summary className="card-head">
        <h2 className="h-card">Every price in this market</h2>
        <span className="fine">Chances, and what it costs to buy or sell</span>
      </summary>
      <div className="table-scroll">
        <table className="scen">
          <thead>
            <tr>
              <th scope="col">Price</th>
              <th scope="col" className="n">
                Chance<span className="sr-only"> of finishing at or above this price</span>
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
              const tag = picked[r.symbol];
              return (
                <tr key={r.symbol} className={tag ? 'is-picked' : rowClass?.(r)}>
                  <td>
                    {money(r.strike)}
                    {tag && <span className="tag">{tag}</span>}
                  </td>
                  <td className="n">{mid !== null ? pct(mid) : '–'}</td>
                  <td className="n">{r.ask !== null ? cents(r.ask) : '–'}</td>
                  <td className="n">{r.bid !== null ? cents(r.bid) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
