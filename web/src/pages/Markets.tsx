import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import Outlook from '../components/Outlook';
import type { MarketEvent } from '../api/types';
import { distributionOf, evenBand, moveText } from '../lib/distribution';
import { money } from '../lib/format';
import { useNow, useResource } from '../lib/hooks';
import { hasPrices } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { categoriesOf, closesIn, filterGroups, updatedLabel } from '../lib/marketFilter';
import { closesLabel, groupByAsset, parlaysOnOffer, strikeSpan } from '../lib/markets';
import { PRODUCTS } from '../lib/nav';
import { keepMode } from '../lib/venue';
import '../styles/markets.css';

type LadderState = 'priced' | 'none' | 'order';

const stateOf = (e: MarketEvent): LadderState => (e.ladderOutOfOrder ? 'order' : hasPrices(e) ? 'priced' : 'none');
const STATE_TEXT: Record<LadderState, string> = { priced: 'Priced', none: 'No prices yet', order: 'Prices unclear' };

/**
 * How far the market expects this market's price to travel: half the width of the band it gives an even chance of holding,
 * as a percent of the band's middle. A dash when the market's prices do not reach far enough either side to say.
 */
function expectedMove(e: MarketEvent): string {
  const levels = distributionOf(e.rungs)?.levels;
  return moveText(levels ? evenBand(levels) : null);
}

export default function Markets() {
  const [params, setParams] = useSearchParams();
  const now = useNow(5000);
  const markets = useResource('markets', () => api.markets(), { live: [[execLive, 'markets']], pollMs: 4000, minGapMs: 800 });

  const groups = useMemo(() => groupByAsset(markets.data?.events ?? []), [markets.data]);
  const categories = useMemo(() => categoriesOf(groups), [groups]);
  const anyPriced = groups.some((g) => g.priced > 0);

  const q = params.get('q') ?? '';
  const catParam = params.get('cat') ?? '';
  const cat = categories.includes(catParam) ? catParam : '';
  // Default is "only priced", unless nothing is priced, when the filter would hide the whole exchange.
  const priced = anyPriced && params.get('priced') !== '0';

  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const patch = (next: Record<string, string | null>): void =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(next)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        return p;
      },
      { replace: true },
    );

  const shown = useMemo(() => filterGroups(groups, { q, cat, priced }), [groups, q, cat, priced]);
  const shownLadders = shown.reduce((n, g) => n + g.events.length, 0);

  const totals = {
    ladders: groups.reduce((n, g) => n + g.events.length, 0),
    priced: groups.reduce((n, g) => n + g.priced, 0),
    offers: groups.reduce((n, g) => n + g.offers, 0),
    assets: groups.length,
  };
  const filtered = q.trim() !== '' || cat !== '' || (anyPriced && !priced) || params.has('priced');
  const status = markets.data ? updatedLabel(markets.data.asOf, now) : null;

  return (
    <div className="page mk">
      <header className="page-head">
        <div>
          <h1 className="h-page">Markets you can bet on</h1>
          <p className="lede">Pick a market and choose how to bet on it.</p>
        </div>
        {status && !markets.error && totals.ladders > 0 && (
          <span className="chip-quiet mk-status">
            <i className="mk-live" aria-hidden="true" />
            {status}
          </span>
        )}
      </header>

      {markets.loading && !markets.data ? (
        <div aria-busy="true" aria-label="Loading markets">
          <div className="skeleton mk-skel-stats" />
          <div className="skeleton mk-skel-bar" />
          {[0, 1].map((i) => (
            <div key={i} className="mk-skel-group">
              <div className="skeleton mk-skel-title" />
              <div className="skeleton mk-skel-table" />
            </div>
          ))}
        </div>
      ) : markets.error && !markets.data ? (
        <div className="mk-state" role="alert">
          <h2 className="mk-state-title">The markets did not load</h2>
          <p>Nothing about your bets has changed.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={markets.reload}>
            Try again
          </button>
        </div>
      ) : (
        totals.ladders === 0 ? (
          <div className="mk-state">
            <h2 className="mk-state-title">No markets are open</h2>
            <p>New markets appear here as soon as they are listed.</p>
          </div>
        ) : (
          <>
            <dl className="mk-stats" role="group" aria-label="Summary">
              <Stat label="Markets open" value={totals.ladders} />
              <Stat label="With prices" value={totals.priced} />
              <Stat label="Stake Back bets on offer" value={totals.offers} />
              <Stat label="Assets" value={totals.assets} />
            </dl>

            {markets.error && <p className="fine mk-stale">The last refresh failed, so these figures may be out of date. Retrying on its own.</p>}

            <Outlook groups={groups} now={now} />

            {!anyPriced && (
              <div className="mk-state mk-calm">
                <h2 className="mk-state-title">No market has prices yet</h2>
                <p>The exchange has listed these markets but nobody has quoted them. Prices usually appear within a few minutes, and this page updates on its own.</p>
              </div>
            )}

            <div className="mk-toolbar">
              <div className="mk-seg" role="group" aria-label="Category">
                {['', ...categories].map((c) => (
                  <button key={c || 'all'} type="button" aria-pressed={cat === c} onClick={() => patch({ cat: c || null })}>
                    {c || 'All'}
                  </button>
                ))}
              </div>
              <div className="mk-search">
                <label htmlFor="mk-q" className="sr-only">
                  Search assets
                </label>
                <input
                  id="mk-q"
                  type="search"
                  value={text}
                  placeholder="Search assets"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setText(e.target.value);
                    patch({ q: e.target.value || null });
                  }}
                />
              </div>
              {anyPriced && (
                <label className="mk-toggle">
                  <input type="checkbox" checked={priced} onChange={(e) => patch({ priced: e.target.checked ? null : '0' })} />
                  Only markets with prices
                </label>
              )}
            </div>

            <p className="mk-count" role="status">
              {shownLadders < totals.ladders
                ? `${shownLadders} of ${totals.ladders} markets shown`
                : `${shownLadders} ${shownLadders === 1 ? 'market' : 'markets'} across ${shown.length} ${shown.length === 1 ? 'asset' : 'assets'}`}
            </p>

            {shown.length === 0 ? (
              <div className="mk-state">
                <h2 className="mk-state-title">Nothing matches</h2>
                <p>Try fewer filters.</p>
                {filtered && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParams({}, { replace: true })}>
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className="mk-groups">
                {shown.map((g) => {
                  const table = (
                    <div className="mk-table-wrap">
                      <table className="mk-table" role="table">
                        <caption className="sr-only">{g.label} markets, soonest close first</caption>
                        <thead role="rowgroup">
                          <tr role="row">
                            <th role="columnheader" scope="col" className="mk-c-closes">Closes</th>
                            <th role="columnheader" scope="col" className="mk-c-num mk-c-range">Price range</th>
                            <th role="columnheader" scope="col" className="mk-c-num mk-c-rungs">Levels</th>
                            <th role="columnheader" scope="col" className="mk-c-num mk-c-move">Expected move</th>
                            <th role="columnheader" scope="col" className="mk-c-num mk-c-offers">Stake Back bets</th>
                            <th role="columnheader" scope="col" className="mk-c-state">Status</th>
                            <th role="columnheader" scope="col" className="mk-c-act">
                              <span className="sr-only">Bet on this market</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody role="rowgroup">
                          {g.events.map((e) => {
                            const span = strikeSpan(e);
                            const st = stateOf(e);
                            const rel = closesIn(e.expiry, now);
                            const open = hasPrices(e);
                            const where = `${g.label}, ${closesLabel(e.expiry, now)}`;
                            return (
                              <tr key={e.ticker} role="row" className="mk-row">
                                <td role="cell" className="mk-closes">
                                  <span className="mk-when">{closesLabel(e.expiry, now)}</span>
                                  {rel && <span className="mk-rel">{rel}</span>}
                                </td>
                                <td role="cell" className="mk-num" data-label="Price range">
                                  {span ? `${money(span.low)} to ${money(span.high)}` : '–'}
                                </td>
                                <td role="cell" className="mk-num mk-rungs" data-label="Levels">
                                  {e.rungs.length}
                                </td>
                                <td role="cell" className="mk-num" data-label="Expected move">
                                  {expectedMove(e)}
                                </td>
                                <td role="cell" className="mk-num" data-label="Stake Back bets">
                                  {!open ? '–' : parlaysOnOffer(e) > 0 ? parlaysOnOffer(e) : <span className="mk-none">None</span>}
                                </td>
                                <td role="cell" className="mk-state-cell" data-label="Status">
                                  <span className="mk-dot" data-state={st} aria-hidden="true" />
                                  {STATE_TEXT[st]}
                                </td>
                                <td role="cell" className="mk-act">
                                  {/* A market with no prices has nothing to open: its status already says so, and the cell stays empty. */}
                                  {open && (
                                    <span className="mk-links">
                                      {PRODUCTS.slice(0, 2).map((p) => (
                                        <Link key={p.id} className="mk-link" to={keepMode(`${p.to}?market=${encodeURIComponent(e.ticker)}`)}>
                                          {p.short}
                                          <span className="sr-only"> on {where}</span>
                                        </Link>
                                      ))}
                                      <Link className="mk-link" to={keepMode(`/hunch?market=${encodeURIComponent(e.ticker)}`)}>
                                        Hunch
                                        <span className="sr-only"> on {where}</span>
                                      </Link>
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                  const count = `${g.events.length} ${g.events.length === 1 ? 'market' : 'markets'}`;
                  // An asset with nothing priced is a closed drawer: one line instead of a table of rows that all say the same.
                  return g.priced === 0 ? (
                    <details key={g.key} className="mk-group mk-group-bare" open={q.trim() !== ''}>
                      <summary className="mk-group-head">
                        <h2 className="mk-group-title">{g.label}</h2>
                        <span className="mk-tag">{g.category}</span>
                        <span className="mk-meta">{count}, no prices yet</span>
                      </summary>
                      {table}
                    </details>
                  ) : (
                    <section key={g.key} className="mk-group" aria-labelledby={`mk-h-${g.key}`}>
                      <div className="mk-group-head">
                        <h2 id={`mk-h-${g.key}`} className="mk-group-title">
                          {g.label}
                        </h2>
                        <span className="mk-tag">{g.category}</span>
                        <span className="mk-meta">
                          {count} · {g.priced} with prices
                        </span>
                      </div>
                      {table}
                    </section>
                  );
                })}
              </div>
            )}

            <p className="fine mk-foot">Expected move is how far the market thinks the price will finish from its middle, in either direction.</p>
          </>
        )
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="mk-stat">
      <dt>{label}</dt>
      <dd>{value.toLocaleString('en-US')}</dd>
    </div>
  );
}
