import { useState } from 'react';
import { api } from '../api';
import type { ReconcileResponse } from '../api/types';
import { usd } from '../lib/format';
import { useResource } from '../lib/hooks';
import { execLive } from '../lib/liveClients';

export default function Proof() {
  const flow = useResource('flow', () => api.flow(), { live: [[execLive, 'bets']], pollMs: 10000 });
  const [rec, setRec] = useState<ReconcileResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    try {
      setRec(await api.reconcile());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The check could not run.');
    } finally {
      setRunning(false);
    }
  }

  const f = flow.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h-page">Proof</h1>
          <p className="lede">Three things you can check yourself: our books match Gemini’s, what we sent to Gemini, and that calls were made before the result.</p>
        </div>
      </header>

      <div className="proof-grid">
        <section className="card">
          <span className="eyebrow">Books match Gemini</span>
          <h2 className="h-card">Reconcile to the cent</h2>
          <p>We compare every order we recorded with Gemini’s own order history, then compare our cash with the account balance.</p>
          <button className="btn btn-primary" onClick={run} disabled={running}>
            {running ? (
              <>
                <span className="spin" aria-hidden="true" /> Checking with Gemini
              </>
            ) : (
              'Check against Gemini'
            )}
          </button>
          {err && (
            <p className="note note-bad" role="alert">
              {err}
            </p>
          )}
          {rec && (
            <dl className="recon" aria-live="polite">
              <div>
                <dt>Orders found</dt>
                <dd>
                  {rec.ordersMatched} of {rec.ordersChecked}
                </dd>
              </div>
              <div>
                <dt>Our books say</dt>
                <dd>{rec.expectedCash === null ? '–' : usd(rec.expectedCash)}</dd>
              </div>
              <div>
                <dt>Account holds</dt>
                <dd>{usd(rec.actualCash)}</dd>
              </div>
              <div className={rec.ok ? 'is-ok' : 'is-off'}>
                <dt>{rec.ok ? 'Difference' : 'Does not match'}</dt>
                <dd>{rec.cashDifference === null ? '–' : usd(rec.cashDifference)}</dd>
              </div>
            </dl>
          )}
        </section>

        <section className="card">
          <span className="eyebrow">What Gemini received</span>
          <h2 className="h-card">Flow to Gemini</h2>
          <p>Every bet is two real orders on Gemini’s own order book. This is the total so far.</p>
          {f ? (
            <dl className="recon">
              <div>
                <dt>Bets</dt>
                <dd>{f.bets}</dd>
              </div>
              <div>
                <dt>Orders sent</dt>
                <dd>{f.ordersSent}</dd>
              </div>
              <div>
                <dt>Contracts</dt>
                <dd>{f.contracts.toLocaleString('en-US')}</dd>
              </div>
              <div>
                <dt>Traded</dt>
                <dd>{usd(f.premium)}</dd>
              </div>
              <div>
                <dt>Fees at live rates</dt>
                <dd>{usd(f.feesAtProductionRates)}</dd>
              </div>
            </dl>
          ) : (
            <div className="skeleton row-skel" />
          )}
          {f && <p className="fine">{f.note}</p>}
        </section>

        <section className="card wide">
          <span className="eyebrow">Made before the result</span>
          <h2 className="h-card">Commit, then reveal</h2>
          <ol className="how">
            <li>
              <b>When you bet</b>
              <span>We write a fingerprint of the call to Solana. It is a hash, so it shows nothing about the bet or about you.</span>
            </li>
            <li>
              <b>After it settles</b>
              <span>If you choose, you reveal the call. The program checks it matches the fingerprint and records the result.</span>
            </li>
            <li>
              <b>Anyone can verify</b>
              <span>The leaderboard is rebuilt from Solana alone. If the rows don’t match the chain, they are wrong.</span>
            </li>
          </ol>
          <p className="fine">Our server signs and pays for these records, so you never touch a wallet or fees. The result is attested by our key, with Gemini’s order IDs as the evidence.</p>
        </section>
      </div>
    </div>
  );
}
