import { api } from '../api';
import { ago, pct } from '../lib/format';
import { useAsync } from '../lib/hooks';

export default function Leaderboard() {
  const lb = useAsync(() => api.leaderboard(), [], 10000);
  const rows = lb.data?.rows ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h-page">Leaderboard</h1>
          <p className="lede">Ranked by how much better your calls did than the market’s own odds. Not by profit and not by how much you bet.</p>
        </div>
        {lb.data && <span className="chip chip-quiet">{api.mode === 'mock' ? 'Demo data' : lb.data.source === 'quicknode-stream' ? 'Live from Solana' : 'Read from Solana'}</span>}
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
                <th className="n">Hit rate</th>
                <th className="n">Edge</th>
                <th className="n hide-s">Last call</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.handle} className={r.handle === 'you' ? 'is-you' : ''}>
                  <td className="r">{r.rank}</td>
                  <td>
                    {r.handle === 'you' ? 'You' : r.handle}
                  </td>
                  <td className="n">{r.calls}</td>
                  <td className="n">{pct(r.hitRate)}</td>
                  <td className={`n ${r.edge > 0 ? 'good' : r.edge < 0 ? 'bad' : ''}`}>{r.edge > 0 ? '+' : r.edge < 0 ? '−' : ''}{Math.abs(r.edge).toFixed(2)}</td>
                  <td className="n hide-s">{ago(r.lastRevealedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card explain">
        <h2 className="h-card">How edge works</h2>
        <p>
          Every call has a fair price when you make it. A win scores one minus that price, a loss scores minus that price, and the scores add up. Beat the odds consistently and your edge climbs; luck on a few calls washes out. Calls where the first half failed are refunded and don’t count.
        </p>
        <p className="fine">Players are anonymous handles. Only calls you choose to reveal appear here.</p>
      </div>
    </div>
  );
}
