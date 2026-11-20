import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { LeaderboardRow } from '../api/types';
import { ago, pct } from '../lib/format';
import { useResource } from '../lib/hooks';
import { chainLive } from '../lib/liveClients';
import { MY_BETS, PRODUCTS } from '../lib/nav';
import '../styles/leaderboard.css';

const edgeText = (e: number) => `${e > 0 ? '+' : e < 0 ? '−' : ''}${Math.abs(e).toFixed(2)}`;
const tone = (e: number) => (e > 0 ? 'good' : e < 0 ? 'bad' : '');

/** The three figures above the table, read from the rows themselves. */
function Summary({ rows }: { rows: LeaderboardRow[] }) {
  const best = rows.length ? Math.max(...rows.map((r) => r.edge)) : null;
  return (
    <dl className="lb-sum" aria-label="Summary">
      <div>
        <dt>Players</dt>
        <dd>{rows.length.toLocaleString('en-US')}</dd>
      </div>
      <div>
        <dt>Revealed calls</dt>
        <dd>{rows.reduce((n, r) => n + r.calls, 0).toLocaleString('en-US')}</dd>
      </div>
      <div>
        <dt>Best edge</dt>
        <dd className={best === null ? '' : tone(best)}>{best === null ? '–' : edgeText(best)}</dd>
      </div>
    </dl>
  );
}

export default function Leaderboard() {
  const lb = useResource('leaderboard', () => api.leaderboard(), { live: [[chainLive, 'leaderboard']], pollMs: 10000 });
  const rows = lb.data?.rows ?? [];
  const minCalls = lb.data?.minCalls ?? 1;
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Ranked by edge</span>
          <h1 className="h-page">Leaderboard</h1>
          <p className="lede">Ranked by how much better your calls did than the market’s own odds, not by profit or by how much you bet.</p>
        </div>
        {lb.data && <span className="chip chip-quiet">{api.mode === 'mock' ? 'Demo data' : lb.data.network === 'fake' ? 'Test chain' : lb.data.source === 'quicknode-stream' ? 'Live from Solana' : 'Read from Solana'}</span>}
      </header>

      {lb.loading && !lb.data ? (
        <div className="stack" aria-busy="true" aria-label="Loading the leaderboard">
          <div className="skeleton lb-skel-sum" />
          <div className="skeleton lb-skel-table" />
        </div>
      ) : (
        <>
          <Summary rows={rows} />
          {rows.length === 0 ? (
            <div className="lb-empty">
              <h2 className="h-card">No revealed calls yet</h2>
              <p>The board is built from calls revealed on Solana. Three steps put you on it:</p>
              <ol>
                <li>
                  <Link to={PRODUCTS[0]!.to}>Place a bet</Link>. Its call is fingerprinted on Solana the moment you do.
                </li>
                <li>Wait for the market to settle.</li>
                <li>
                  Reveal the call from <Link to={MY_BETS.to}>{MY_BETS.name}</Link>. {minCalls > 1 ? `A player is ranked from ${minCalls} revealed calls.` : 'It counts here at once.'}
                </li>
              </ol>
            </div>
          ) : (
            <div className="lb-wrap">
              <table className="lb">
                <caption className="sr-only">Players ranked by edge</caption>
                <thead>
                  <tr>
                    <th scope="col" className="lb-rank">
                      Rank
                    </th>
                    <th scope="col">Player</th>
                    <th scope="col" className="n">
                      Calls
                    </th>
                    <th scope="col" className="n lb-opt">
                      Hit rate
                    </th>
                    <th scope="col" className="n">
                      Edge
                    </th>
                    <th scope="col" className="n lb-opt">
                      Last call
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const name = r.handle === 'you' ? 'You' : r.handle;
                    const isOpen = open === r.handle;
                    return (
                      <Fragment key={r.handle}>
                        <tr className={r.handle === 'you' ? 'is-you' : undefined}>
                          <td className="lb-rank">{r.rank}</td>
                          <td className="lb-who">
                            {r.recent && r.recent.length > 0 ? (
                              <button type="button" className="lb-toggle" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.handle)}>
                                <span className="lb-caret" aria-hidden="true" />
                                {name}
                              </button>
                            ) : (
                              name
                            )}
                          </td>
                          <td className="n">{r.calls}</td>
                          <td className="n lb-opt">{pct(r.hitRate)}</td>
                          <td className={`n lb-edge ${tone(r.edge)}`}>{edgeText(r.edge)}</td>
                          <td className="n lb-opt lb-when">{ago(r.lastRevealedAt)}</td>
                        </tr>
                        {isOpen && r.recent && (
                          <tr className="lb-calls">
                            <td colSpan={6}>
                              <ul aria-label={`${name}'s revealed calls`}>
                                {r.recent.map((c) => (
                                  <li key={c.signature}>
                                    <span className="status" data-outcome={c.outcome === 1 ? 'won' : 'lost'}>
                                      {c.outcome === 1 ? 'Won' : 'Lost'}
                                    </span>
                                    <span className={`lb-edge ${tone(c.edge)}`}>{edgeText(c.edge)}</span>
                                    <span className="lb-when">{ago(c.revealedAt)}</span>
                                    <Link to={`/verify/${c.signature}`}>Check it on Solana</Link>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <section className="lb-explain" aria-labelledby="lb-how">
        <div>
          <h2 id="lb-how" className="h-card">
            How edge works
          </h2>
          <p>Every call has a fair price when you make it: the market’s own chance that it comes off. A hit scores one minus that price, a miss scores minus that price, and a player’s edge is the sum.</p>
          <p>Beating the odds again and again moves you up; a lucky call or two washes out. A refunded call, where the first half failed, is not scored.</p>
          <p className="fine">Players are anonymous handles. Only calls a player chooses to reveal appear here.</p>
        </div>
        {/* A list rather than a table, so the board stays the only table on the page. */}
        <figure className="lb-example">
          <figcaption>One call made at a fair price of 41¢</figcaption>
          <dl>
            <div>
              <dt>The second half happens</dt>
              <dd className="good">+0.59</dd>
            </div>
            <div>
              <dt>The first half holds, the second does not</dt>
              <dd className="bad">−0.41</dd>
            </div>
            <div>
              <dt>The first half fails, stake refunded</dt>
              <dd className="lb-none">Not scored</dd>
            </div>
          </dl>
        </figure>
      </section>
    </div>
  );
}
