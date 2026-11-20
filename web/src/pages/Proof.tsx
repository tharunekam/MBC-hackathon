import { useState } from 'react';
import { api } from '../api';
import type { ReconcileResponse } from '../api/types';
import { usd } from '../lib/format';
import { useResource } from '../lib/hooks';
import { execLive } from '../lib/liveClients';
import { useVenue } from '../lib/venue';

export default function Proof() {
  const venue = useVenue();
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
          <span className="eyebrow">Check our books</span>
          <h1 className="h-page">Proof</h1>
          <p className="lede">Three things you can check yourself: our books match Gemini’s, what we sent to Gemini, and that calls were made before the result.</p>
        </div>
      </header>

      <div className="proof-grid">
        <section className="card">
          <span className="eyebrow">Books match Gemini</span>
          <h2 className="h-card">Reconcile to the cent</h2>
          <p>We compare every order we recorded with Gemini’s own order history, then compare our cash with the account balance.</p>
          <button className="btn btn-primary" onClick={run} disabled={running || venue.readOnly} aria-describedby={venue.readOnly ? 'recon-why' : undefined}>
            {running ? (
              <>
                <span className="spin" aria-hidden="true" /> Checking with Gemini
              </>
            ) : (
              'Check against Gemini'
            )}
          </button>
          {venue.readOnly && (
            <p id="recon-why" className="fine">
              This needs a connected Gemini account. This demo shows live prices only, so there is nothing to reconcile.
            </p>
          )}
          {err && (
            <p className="note note-bad" role="alert">
              {err}
            </p>
          )}
          {!rec && !err && (
            // What the result will look like, so the card is not an empty box before the first check.
            <dl className="recon is-idle" aria-label="What the check reports">
              {['Orders found', 'Our books say', 'Account holds', 'Difference'].map((t) => (
                <div key={t}>
                  <dt>{t}</dt>
                  <dd>–</dd>
                </div>
              ))}
            </dl>
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
          {rec && (rec.nettedCash ?? 0) > 0 && (
            <p className="fine">
              Gemini cancels a YES and a NO on the same contract against each other the moment you hold both, and pays {usd(1)} for each pair straight away.
              Here that is {usd(rec.nettedCash ?? 0)} on {rec.nettedContracts} contracts. It is the same money arriving sooner, and it is already counted above.
            </p>
          )}
          {rec && (rec.betsResolvedByHand?.length ?? 0) > 0 && (
            <p className="fine">
              {rec.betsResolvedByHand!.length === 1 ? 'One bet was' : `${rec.betsResolvedByHand!.length} bets were`} settled by Gemini without a plain yes or no. What{' '}
              {rec.betsResolvedByHand!.length === 1 ? 'it' : 'they'} paid was read from the account and entered by hand, and is counted above.
            </p>
          )}
          {rec && rec.betsNeedingReview.length > 0 && (
            <p className="fine">
              {rec.betsNeedingReview.length === 1 ? 'One bet was' : `${rec.betsNeedingReview.length} bets were`} settled by Gemini without a plain yes or no, and what{' '}
              {rec.betsNeedingReview.length === 1 ? 'it' : 'they'} paid has not been entered yet. Any difference above is that money.
            </p>
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
