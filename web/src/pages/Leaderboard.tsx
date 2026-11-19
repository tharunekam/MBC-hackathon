import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ago, pct } from '../lib/format';
import { useResource } from '../lib/hooks';
import { chainLive } from '../lib/liveClients';

const edgeText = (e: number) => `${e > 0 ? '+' : e < 0 ? '−' : ''}${Math.abs(e).toFixed(2)}`;

export default function Leaderboard() {
  const lb = useResource('leaderboard', () => api.leaderboard(), { live: [[chainLive, 'leaderboard']], pollMs: 10000 });
  const rows = lb.data?.rows ?? [];
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h-page">Leaderboard</h1>
          <p className="lede">Ranked by how much better your calls did than the market’s own odds. Not by profit and not by how much you bet.</p>
        </div>
        {lb.data && <span className="chip chip-quiet">{api.mode === 'mock' ? 'Demo data' : lb.data.network === 'fake' ? 'Test chain' : lb.data.source === 'quicknode-stream' ? 'Live from Solana' : 'Read from Solana'}</span>}
      </header>

      <div className="card table-card">
        {lb.loading && !lb.data ? (
          <div className="stack pad">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton row-skel" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-card">
            <h2 className="h-card">No revealed calls yet</h2>
            <p>Place a bet, let it settle, then reveal it to appear here.</p>
          </div>
        ) : (
          <table className="lb">
            <thead>
              <tr>
                <th className="r">#</th>
                <th>Player</th>
                <th className="n">Calls</th>
                <th className="n hide-s">Hit rate</th>
                <th className="n">Edge</th>
                <th className="n hide-s">Last call</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const name = r.handle === 'you' ? 'You' : r.handle;
                const isOpen = open === r.handle;
                return (
                  <Fragment key={r.handle}>
                    <tr className={r.handle === 'you' ? 'is-you' : ''}>
                      <td className="r">{r.rank}</td>
                      <td>
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
                      <td className="n hide-s">{pct(r.hitRate)}</td>
                      <td className={`n ${r.edge > 0 ? 'good' : r.edge < 0 ? 'bad' : ''}`}>{edgeText(r.edge)}</td>
                      <td className="n hide-s">{ago(r.lastRevealedAt)}</td>
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
                                <span className={c.edge >= 0 ? 'good' : 'bad'}>{edgeText(c.edge)}</span>
                                <span className="fine">{ago(c.revealedAt)}</span>
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
        )}
      </div>

      <div className="card explain">
        <h2 className="h-card">How edge works</h2>
        <p>
          Every call has a fair price when you make it. A win scores one minus that price, a loss scores minus that price, and the scores add up. Beat the odds consistently and your edge climbs; luck on a few calls washes out. Calls where the first half failed are refunded and don’t count.
        </p>
        <div className="payoff-grid" role="group" aria-label="Worked example: a call made at a fair price of 41 cents">
          <div data-kind="win">
            <span className="po-chance">Fair price 41¢ when made</span>
            <b>+0.59</b>
            <p>The second half happens: 1 − 0.41</p>
          </div>
          <div data-kind="back">
            <span className="po-chance">Refunded</span>
            <b>Not scored</b>
            <p>The first half fails, so there is nothing to judge</p>
          </div>
          <div data-kind="lose">
            <span className="po-chance">Fair price 41¢ when made</span>
            <b>−0.41</b>
            <p>The first half holds, the second does not</p>
          </div>
        </div>
        <p className="fine">Worked example, not a real call. Players are anonymous handles, and only calls you choose to reveal appear here.</p>
      </div>
    </div>
  );
}
