import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CallRecord } from '../api/types';
import { explorerTx } from '../api/types';
import { betTitle, kindOf } from '../lib/betKind';
import { CashOut } from '../components/CashOut';
import OpenBetsCard from '../components/OpenBetsCard';
import {
  basketSummary,
  canRevealCall,
  checkedWords,
  filterEntries,
  finishedWords,
  groupBets,
  hasPending,
  ifItComesOff,
  isSettled,
  kindLabel,
  netLabel,
  orderIdWords,
  orderLine,
  outcomeOf,
  realised,
  sellOrdersWords,
  soldCallWords,
  stakeOf,
  statusWords,
  summarize,
} from '../lib/betsView';
import type { Entry, Filter } from '../lib/betsView';
import { ago, cents, money, trunc, usd, usdSigned } from '../lib/format';
import { useNow, useResource } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { PRODUCTS } from '../lib/nav';
import { keepMode, useVenue } from '../lib/venue';
import '../styles/bets.css';

const tone = (n: number) => (n > 0.004 ? 'good' : n < -0.004 ? 'bad' : '');
const edgeText = (e: number) => `${e > 0 ? '+' : e < 0 ? '−' : ''}${Math.abs(e).toFixed(2)}`;

const FILTERS: { id: Filter; name: string }[] = [
  { id: 'all', name: 'All' },
  { id: 'open', name: 'Open' },
  { id: 'settled', name: 'Settled' },
];

interface RowProps {
  bet: Bet;
  call: CallRecord | undefined;
  revealing: string | null;
  onReveal: (callId: string) => void;
  /** Called when a bet has been sold back, with a sentence saying so. */
  onCashedOut: (message: string) => void;
  /** Shown in a basket: the leg number goes before the bet. */
  leg?: number;
}

/** The result column: what the bet paid, what it pays if it comes off, or nothing yet. */
function Result({ bet }: { bet: Bet }) {
  const o = outcomeOf(bet);
  const paid = realised(bet);
  // Under a settled result: where the price ended, when the exchange said.
  const finished = finishedWords(bet);
  if (o === 'back')
    return (
      <>
        <b className="back">Stake back</b>
        {finished && <small>{finished}</small>}
      </>
    );
  if (o === 'open') {
    const p = ifItComesOff(bet);
    return (
      <>
        <b className="bl-pending">{usdSigned(p.amount)}</b>
        <small>{p.condition}</small>
      </>
    );
  }
  if (o === 'review')
    // Not a win amount: the market is over. Show what was actually paid once someone has entered it.
    return (
      <>
        <b className={paid ? tone(paid.pnl) : ''}>{paid ? usdSigned(paid.pnl) : '–'}</b>
        <small>{paid ? 'entered by hand' : 'being checked'}</small>
      </>
    );
  if (paid)
    return (
      <>
        <b className={tone(paid.pnl)}>{usdSigned(paid.pnl)}</b>
        {finished && <small>{finished}</small>}
      </>
    );
  return <b className="bl-none">–</b>;
}

function BetRow({ bet, call, revealing, onReveal, onCashedOut, leg }: RowProps) {
  const [open, setOpen] = useState(false);
  const o = outcomeOf(bet);
  const kind = kindOf(bet);
  const hand = bet.review?.resolved ?? null;
  const detailId = `bet-${bet.id}-orders`;
  // A call can be revealed once it has a plain result: the bet settled won or lost, or it was sold back and its market has
  // since settled. Selling a bet early ends the bet, not the call.
  const revealable = !!call && call.state === 'committed' && canRevealCall(bet);
  const revealButton = revealable && call && (
    <button type="button" className="btn btn-ghost bl-btn" disabled={revealing === call.id} onClick={() => onReveal(call.id)}>
      {revealing === call.id ? 'Revealing' : 'Reveal on Solana'}
    </button>
  );
  const sellOrders = sellOrdersWords(bet);

  return (
    <div className="bl-row" data-bet={bet.id} data-outcome={o}>
      <div className="bl-line">
        <div className="bl-what">
          <div className="bl-tags">
            {leg !== undefined && <span className="bl-leg">Leg {leg}</span>}
            <span className="kind-tag">{kindLabel(kind)}</span>
          </div>
          <p className="bl-title">{betTitle(bet)}</p>
          <p className="bl-meta">
            {bet.eventTitle} · {ago(bet.createdAt)}
          </p>
        </div>
        <div className="bl-fig bl-stake">
          <span className="bl-k">Stake</span>
          <b>{usd(stakeOf(bet))}</b>
        </div>
        <div className="bl-fig bl-state">
          <span className="bl-k">Status</span>
          <span className="bl-chip" data-outcome={o}>
            {statusWords(bet)}
          </span>
        </div>
        <div className="bl-fig bl-res">
          <span className="bl-k">Result</span>
          <Result bet={bet} />
        </div>
      </div>

      {/* What became of the money first, then what became of the call. */}
      {o === 'cashed' && bet.cashOut && (
        <div className="bl-foot">
          <p>
            Sold back for <b>{usd(bet.cashOut.proceeds)}</b> before the market settled{sellOrders ? `, ${sellOrders}` : ''}. {soldCallWords(bet)}
            {revealable && ' Reveal it to put it on the leaderboard. It shows the bet and the result, never your account.'}
          </p>
          {revealButton}
        </div>
      )}
      {revealable && o !== 'cashed' && (
        <div className="bl-foot">
          <p>Reveal this call to put it on the leaderboard. It shows the bet and the result, never your account.</p>
          {revealButton}
        </div>
      )}
      {call?.state === 'revealed' && call.reveal && (
        <div className="bl-foot">
          <p>
            Revealed on Solana. Edge scored <b className={call.reveal.edge !== null ? tone(call.reveal.edge) : ''}>{call.reveal.edge !== null ? edgeText(call.reveal.edge) : '–'}</b>
          </p>
          <div className="bl-links">
            <Link to={keepMode(`/verify/${call.reveal.signature}`)}>Call proof</Link>
            <Link to={keepMode('/leaderboard')}>Leaderboard</Link>
          </div>
        </div>
      )}
      {(bet.status === 'open' || bet.status === 'unhedged') && <CashOut bet={bet} onDone={onCashedOut} />}
      {o === 'back' && (
        <div className="bl-foot">
          <p>The first level failed, so your stake came back. This call is not scored.</p>
        </div>
      )}
      {o === 'review' && (
        <div className="bl-foot">
          <p>
            This market was settled without a plain yes or no. {hand ? `It paid ${usd(hand.payout)}, read from the account and entered by hand.` : 'We are checking what it paid.'} This call is not scored.
          </p>
        </div>
      )}

      <button type="button" className="bl-expand" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
        <span className="bl-caret" aria-hidden="true" />
        Orders and proof
      </button>
      <div id={detailId} className="bl-detail" hidden={!open}>
        <ol className="bl-orders" aria-label="Orders">
          {bet.legs.map((l) => {
            const w = orderLine(bet, l);
            return (
              <li key={l.clientOrderId}>
                <span className="bl-k">{w.label}</span>
                <span className="bl-order">
                  <span>{w.bets}</span>
                  <span className="bl-fill">
                    {l.quantityFilled} {w.side}
                    {w.strike !== null ? ` on ${money(w.strike)}` : ''} at {l.avgPrice !== null ? cents(l.avgPrice) : '–'}
                    {l.status !== 'filled' ? ` · ${l.status}` : ''}
                  </span>
                </span>
                {l.orderId ? <code className="bl-id">{orderIdWords(l.orderId)}</code> : <span className="bl-id bl-none">{orderIdWords(undefined)}</span>}
              </li>
            );
          })}
          {bet.legs.length === 0 && <li className="bl-none">No orders were sent.</li>}
        </ol>
        <dl className="bl-proof">
          <div>
            <dt className="bl-k">Bet id</dt>
            <dd>
              <code className="bl-id">{bet.id}</code>
            </dd>
          </div>
          {call && (
            <div>
              <dt className="bl-k">On Solana</dt>
              <dd>
                {call.state === 'revealed' ? 'Revealed' : call.state === 'void' ? (o === 'cashed' ? 'Not scored, the first level failed' : 'Refunded, not scored') : 'Committed'}
                {call.network === 'devnet' ? (
                  <a className="bl-id" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
                    {trunc(call.commitSignature, 8, 6)} ↗<span className="sr-only"> (opens the explorer in a new tab)</span>
                  </a>
                ) : (
                  <code className="bl-id">{trunc(call.commitSignature, 8, 6)} · test chain</code>
                )}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

function BasketPanel({ entry, all, ...rest }: { entry: Extract<Entry, { type: 'basket' }>; all: Extract<Entry, { type: 'basket' }> } & Omit<RowProps, 'bet' | 'call' | 'leg'> & { callFor: (id: string) => CallRecord | undefined }) {
  // The header always describes the whole basket, even when a filter shows only some of its legs.
  const s = basketSummary(all);
  const { callFor, ...row } = rest;
  return (
    <li className="bl-panel bl-basket">
      <header className="bl-bhead">
        <div>
          <span className="kind-tag">Basket</span>
          <h2 className="bl-bname">{all.name ?? 'Basket'}</h2>
          <p className="bl-meta">
            Placed {ago(s.placedAt)} · {s.legs === s.size ? `${s.legs} legs` : `${s.legs} of ${s.size} legs placed`}
          </p>
        </div>
        <dl className="bl-bfigs">
          <div>
            <dt className="bl-k">Staked</dt>
            <dd>{usd(s.stake)}</dd>
          </div>
          <div>
            <dt className="bl-k">Settled</dt>
            <dd>
              {s.settled} of {s.legs}
            </dd>
          </div>
          {s.net !== null && (
            <div>
              <dt className="bl-k">{netLabel(s)}</dt>
              <dd className={tone(s.net)}>{usdSigned(s.net)}</dd>
            </div>
          )}
        </dl>
      </header>
      <ol className="bl-legs">
        {entry.legs.map((b) => (
          <li key={b.id}>
            <BetRow bet={b} call={callFor(b.id)} leg={(b.basket?.index ?? 0) + 1} {...row} />
          </li>
        ))}
      </ol>
    </li>
  );
}

export default function Bets() {
  const venue = useVenue();
  const bets = useResource('bets', () => api.bets(), { live: [[execLive, 'bets']], pollMs: 8000 });
  const calls = useResource('calls', () => api.calls(), { live: [[chainLive, 'calls']], pollMs: 8000 });
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  useNow(30_000); // keeps "12 min ago" current

  const list = useMemo(() => bets.data?.bets ?? [], [bets.data]);
  const callFor = (id: string): CallRecord | undefined => calls.data?.calls.find((c) => c.betId === id);
  const totals = useMemo(() => summarize(list), [list]);
  const entries = useMemo(() => groupBets(list), [list]);
  const shown = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const counts: Record<Filter, number> = { all: list.length, open: list.filter((b) => outcomeOf(b) === 'open').length, settled: list.filter(isSettled).length };

  async function check() {
    setChecking(true);
    setNote(null);
    setError(null);
    try {
      const r = await api.settle();
      // The executor also lists the sold-back bets whose call has just been given its result; an older one sends no such list.
      const called = r.called?.length ?? 0;
      setNote(checkedWords({ settled: r.settled.length, called, stillOpen: r.stillOpen }));
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
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reveal this call.');
    } finally {
      // Reloaded either way: a refusal can change the call too (a call whose first level failed is marked as not counting).
      calls.reload();
      setRevealing(null);
    }
  }

  function cashedOut(message: string) {
    setError(null);
    setNote(message);
    bets.reload();
  }

  const loading = bets.loading && !bets.data;
  const failed = !bets.data && bets.error;
  const checkable = useMemo(() => hasPending(list), [list]);

  return (
    <div className="page bets">
      <header className="page-head">
        <div>
          <span className="eyebrow">Open and settled</span>
          <h1 className="h-page">My bets</h1>
          <p className="lede">Each bet is a pair of orders placed on {venue.place}. Results arrive here as markets settle.</p>
        </div>
        {/* Only while something can still change: an open bet, one under review, or one sold back whose market has not settled. */}
        {(checkable || checking) && (
          <button type="button" className="btn btn-ghost" onClick={check} disabled={checking}>
            {checking ? (
              <>
                <span className="spin" aria-hidden="true" /> Checking
              </>
            ) : (
              'Check results'
            )}
          </button>
        )}
      </header>

      {(note || error) && (
        <p className={`note ${error ? 'note-bad' : 'note-info'}`} role={error ? 'alert' : 'status'}>
          {error ?? note}
        </p>
      )}

      {loading ? (
        <div className="bl-skels" aria-busy="true" aria-label="Loading your bets">
          <div className="bl-skel bl-skel-sum" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="bl-skel bl-skel-row" />
          ))}
        </div>
      ) : failed ? (
        <div className="bl-empty" role="alert">
          <h2 className="h-card">We could not load your bets</h2>
          <p>{bets.error?.message ?? 'The service did not answer.'} Bets you have placed are not affected: this page only reads them.</p>
          <button type="button" className="btn btn-ghost" onClick={() => bets.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {list.length > 0 && (
            <dl className="bl-sum" aria-label="Summary">
              <div>
                <dt className="eyebrow">Bets</dt>
                <dd>{totals.count}</dd>
                <dd className="bl-unit">
                  {totals.open} open · {totals.settled} settled
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Staked</dt>
                <dd>{usd(totals.staked)}</dd>
                <dd className="bl-unit">USD, every bet placed</dd>
              </div>
              <div>
                <dt className="eyebrow">Returned</dt>
                <dd>{usd(totals.returned)}</dd>
                <dd className="bl-unit">USD, paid by settled bets</dd>
              </div>
              <div>
                <dt className="eyebrow">Net</dt>
                <dd className={tone(totals.net)}>{usdSigned(totals.net)}</dd>
                <dd className="bl-unit">USD, settled bets only</dd>
              </div>
            </dl>
          )}

          {/* What the open bets add up to, market by market. It renders nothing when no bet is open, or until prices arrive. */}
          <OpenBetsCard bets={list} />

          {list.length === 0 ? (
            <div className="bl-empty">
              <h2 className="h-card">No bets yet</h2>
              <p>A bet you place shows up here at once, with both of its orders and how it settles.</p>
              <ul className="bl-start">
                {PRODUCTS.map((p) => (
                  <li key={p.id}>
                    <Link to={keepMode(p.to)}>
                      <b>{p.name}</b>
                      <span>{p.tagline}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div className="bl-bar">
                <div className="switch" role="group" aria-label="Show">
                  {FILTERS.map((f) => (
                    <button key={f.id} type="button" className={filter === f.id ? 'is-on' : undefined} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                      {f.name} <span className="bl-count">{counts[f.id]}</span>
                    </button>
                  ))}
                </div>
                <span className="bl-cols" aria-hidden="true">
                  <span>Stake</span>
                  <span>Status</span>
                  <span>Result</span>
                </span>
              </div>
              {shown.length === 0 ? (
                <p className="bl-none-line">{filter === 'open' ? 'No open bets right now.' : 'No settled bets yet.'}</p>
              ) : (
                <ul className="bets-list">
                  {shown.map((e) =>
                    e.type === 'single' ? (
                      <li key={e.bet.id} className="bl-panel">
                        <BetRow bet={e.bet} call={callFor(e.bet.id)} revealing={revealing} onReveal={reveal} onCashedOut={cashedOut} />
                      </li>
                    ) : (
                      <BasketPanel key={e.id} entry={e} all={entries.find((x): x is Extract<Entry, { type: 'basket' }> => x.type === 'basket' && x.id === e.id) ?? e} callFor={callFor} revealing={revealing} onReveal={reveal} onCashedOut={cashedOut} />
                    ),
                  )}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
