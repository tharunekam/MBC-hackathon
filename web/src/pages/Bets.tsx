import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CallRecord } from '../api/types';
import { explorerTx } from '../api/types';
import { ago, cents, money, trunc, usd, usdSigned } from '../lib/format';
import { useResource } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';

type Outcome = 'open' | 'won' | 'back' | 'lost' | 'review' | 'other';

function outcomeOf(b: Bet): Outcome {
  if (b.status === 'needs_review') return 'review';
  if (b.status === 'open' || b.status === 'unhedged' || b.status === 'placing') return 'open';
  if (b.status === 'settled' && b.settlement) {
    if (b.settlement.conditionResolved === 'no') return 'back';
    return b.settlement.targetResolved === 'yes' ? 'won' : 'lost';
  }
  return 'other';
}

const LABEL: Record<Outcome, string> = { open: 'Open', won: 'Won', back: 'Money back', lost: 'Lost', review: 'Needs review', other: 'Not placed' };

export default function Bets() {
  const bets = useResource('bets', () => api.bets(), { live: [[execLive, 'bets']], pollMs: 8000 });
  const calls = useResource('calls', () => api.calls(), { live: [[chainLive, 'calls']], pollMs: 8000 });
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = bets.data?.bets ?? [];
  const callFor = (id: string): CallRecord | undefined => calls.data?.calls.find((c) => c.betId === id);

  const totals = useMemo(() => {
    const placed = list.filter((b) => outcomeOf(b) !== 'other');
    const settled = list.filter((b) => b.status === 'settled' && b.settlement);
    const staked = placed.reduce((n, b) => n + b.cost, 0);
    const returned = settled.reduce((n, b) => n + (b.settlement?.payout ?? 0), 0);
    const net = settled.reduce((n, b) => n + (b.settlement?.pnl ?? 0), 0);
    return { count: placed.length, staked, returned, net, open: placed.filter((b) => outcomeOf(b) === 'open').length };
  }, [list]);

  async function check() {
    setChecking(true);
    setNote(null);
    setError(null);
    try {
      const r = await api.settle();
      setNote(r.settled.length > 0 ? `${r.settled.length} bet${r.settled.length === 1 ? '' : 's'} settled.` : r.stillOpen > 0 ? 'Nothing has closed yet. Markets settle a few seconds after they expire.' : 'Everything is up to date.');
      bets.reload();
      calls.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check results.');
    } finally {
      setChecking(false);
    }
  }

  async function reveal(callId: string) {
    setRevealing(callId);
    setError(null);
    try {
      await api.revealCall(callId);
      calls.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reveal this call.');
    } finally {
      setRevealing(null);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h-page">My bets</h1>
          <p className="lede">Every bet is two orders in your Gemini account. Here is how each one landed.</p>
        </div>
        <button className="btn btn-ghost" onClick={check} disabled={checking}>
          {checking ? (
            <>
              <span className="spin" aria-hidden="true" /> Checking
            </>
          ) : (
            'Check results'
          )}
        </button>
      </header>

      <div className="stats">
        <div className="card stat">
          <span>Bets</span>
          <b>{totals.count}</b>
        </div>
        <div className="card stat">
          <span>Staked</span>
          <b>{usd(totals.staked)}</b>
        </div>
        <div className="card stat">
          <span>Returned</span>
          <b>{usd(totals.returned)}</b>
        </div>
        <div className="card stat">
          <span>Net</span>
          <b className={totals.net > 0.004 ? 'good' : totals.net < -0.004 ? 'bad' : ''}>{usdSigned(totals.net)}</b>
        </div>
      </div>

      {(note || error) && (
        <p className={`note ${error ? 'note-bad' : 'note-info'}`} role={error ? 'alert' : 'status'}>
          {error ?? note}
        </p>
      )}

      {bets.loading && !bets.data ? (
        <div className="stack">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton row-skel" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="card empty-card">
          <h2 className="h-card">No bets yet</h2>
          <p>Build your first one. It takes a few seconds.</p>
          <Link to="/app" className="btn btn-primary">
            Build a bet
          </Link>
        </div>
      ) : (
        <div className="stack">
          {list.map((b) => {
            const o = outcomeOf(b);
            const call = callFor(b.id);
            const result = b.settlement;
            return (
              <article key={b.id} className="card bet" data-outcome={o}>
                <div className="bet-main">
                  <div>
                    <span className="eyebrow">{b.eventTitle}</span>
                    <h2 className="bet-title">
                      Given <em>{money(b.condition.strike)}</em>, reach <em>{money(b.target.strike)}</em>
                    </h2>
                    <p className="fine">
                      {usd(b.cost)} · {ago(b.createdAt)}
                    </p>
                  </div>
                  <div className="bet-result">
                    <span className="status" data-outcome={o}>
                      {LABEL[o]}
                    </span>
                    <b className={result ? (o === 'back' ? 'back' : result.pnl > 0.004 ? 'good' : result.pnl < -0.004 ? 'bad' : 'back') : ''}>
                      {result ? (o === 'back' ? 'Stake back' : usdSigned(result.pnl)) : `Wins ${usdSigned(b.payoffs?.ifBothHit ?? 0)}`}
                    </b>
                  </div>
                </div>

                <details className="orders">
                  <summary>Orders and proof</summary>
                  <div className="orders-body">
                    {b.legs.map((l) => (
                      <p key={l.clientOrderId}>
                        <span>{l.role === 'outcome' ? 'Order 1' : 'Order 2'}</span> {l.quantityFilled} contracts {l.outcome === 'yes' ? 'YES' : 'NO'} at {l.avgPrice !== null ? cents(l.avgPrice) : '–'}
                        {l.orderId && <code className="mono-chip">{trunc(l.orderId, 6, 4)}</code>}
                      </p>
                    ))}
                    {call && (
                      <p>
                        <span>On Solana</span> {call.state === 'revealed' ? 'Revealed' : call.state === 'void' ? 'Refunded, not scored' : 'Committed'}
                        {call.network === 'devnet' ? (
                          <a className="mono-chip link" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
                            {trunc(call.commitSignature, 8, 6)} ↗
                          </a>
                        ) : (
                          <code className="mono-chip">{trunc(call.commitSignature, 8, 6)} · test chain</code>
                        )}
                      </p>
                    )}
                  </div>
                </details>

                {call && call.state === 'committed' && (o === 'won' || o === 'lost') && (
                  <div className="bet-foot">
                    <p>Reveal this call to put it on the leaderboard. It shows the bet and the result, never your account.</p>
                    <button className="btn btn-ghost" disabled={revealing === call.id} onClick={() => reveal(call.id)}>
                      {revealing === call.id ? 'Revealing' : 'Reveal on Solana'}
                    </button>
                  </div>
                )}
                {call?.state === 'revealed' && call.reveal && (
                  <div className="bet-foot">
                    <p>
                      Revealed. Edge scored: <b>{call.reveal.edge !== null ? `${call.reveal.edge > 0 ? '+' : '−'}${Math.abs(call.reveal.edge).toFixed(2)}` : '–'}</b>.
                    </p>
                    <div className="row-actions">
                      <Link to={`/verify/${call.reveal.signature}`} className="btn btn-ghost">
                        Proof page
                      </Link>
                      <Link to="/leaderboard" className="btn btn-ghost">
                        Leaderboard
                      </Link>
                    </div>
                  </div>
                )}
                {o === 'back' && (
                  <div className="bet-foot">
                    <p>The first half failed, so your stake came back and this call does not count either way.</p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
