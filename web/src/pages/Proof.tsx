import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { CallRecord, ReconcileResponse } from '../api/types';
import { explorerTx } from '../api/types';
import { kindOfBetId } from '../lib/betKind';
import { kindLabel } from '../lib/betsView';
import { resultWord } from '../lib/callWords';
import { ago, trunc, usd } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useNow, useResource } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { MY_BETS, PRODUCTS } from '../lib/nav';
import { explorerAddress } from '../lib/programBoard';
import { keepMode, useVenue } from '../lib/venue';
import type { VenueNote } from '../lib/venue';
import '../styles/bets.css'; // the product tag
import '../styles/proof.css';

/** How many of the visitor's calls the page lists. The rest are on My bets. */
const CALLS_SHOWN = 5;

const edgeText = (e: number) => `${e > 0 ? '+' : e < 0 ? '−' : ''}${Math.abs(e).toFixed(2)}`;

/**
 * Where this server's bets really go, in the words each card needs. Demo data and a replay place nothing, and a stand-in
 * is not Gemini, so none of the three may read as an order on Gemini. It reads the venue's `place` phrase, which
 * venue.test.ts pins: "Gemini", "Gemini’s sandbox", "a recorded session", or the name of a stand-in.
 */
function whereItRuns(venue: VenueNote) {
  const demo = api.mode === 'mock';
  const replay = venue.place === 'a recorded session';
  // Until the executor has said what it is, the page names nothing.
  const known = venue.chip !== null;
  const gemini = known && !demo && !replay && venue.place.startsWith('Gemini');
  return {
    /** Ends the reconcile card's paragraph. */
    books: demo
      ? 'This is demo data, so the check below runs on made-up books.'
      : replay
        ? 'This is a recorded session played back, so the check below is the one that was recorded.'
        : known
          ? `Here the exchange is ${venue.place}.`
          : '',
    /** The reconcile button. Browser checks find it by "Check against Gemini", so every form begins with those words. */
    button: !known || venue.place === 'Gemini' ? 'Check against Gemini' : gemini ? `Check against ${venue.place}` : 'Check against the test exchange',
    /** Opens the orders card. */
    orders: demo
      ? 'This is demo data, so no order is sent anywhere. On a live server every bet goes in as two orders in one exchange account, and these would be that account’s totals.'
      : replay
        ? 'This is a recorded session played back, so no order is placed now. These are the totals as they were recorded: every bet went in as two orders in one account.'
        : `Every bet goes in as two orders on ${venue.place}, and selling one back is two more. These totals are for the bets placed through this server’s one account.`,
    /** After a check: what it was checked against. */
    checked: demo ? 'demo data' : venue.place,
  };
}

/** One of the visitor's own calls: what state it is in, and the thing a person can open to check it. */
function CallLine({ call }: { call: CallRecord }) {
  const kind = kindLabel(kindOfBetId(call.betId));
  const real = call.network === 'devnet';
  const r = call.state === 'revealed' ? call.reveal : undefined;
  // A commit is a fingerprint and a handle, so there is something to open only where it is a real transaction.
  const commit = real ? (
    <a className="mono-chip link" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
      Commit {trunc(call.commitSignature, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
    </a>
  ) : (
    <code className="mono-chip">{trunc(call.commitSignature, 6, 4)} · test chain</code>
  );

  if (r) {
    return (
      <li>
        <span className="status" data-outcome={r.outcome === 1 ? 'won' : r.outcome === 0 ? 'lost' : undefined}>
          {r.outcome === null ? 'Revealed' : resultWord(r.outcome)}
        </span>
        <span className="pf-what">
          <span className="kind-tag">{kind}</span>
          {r.eventTitle}
          <small>
            Revealed {ago(r.revealedAt)}
            {r.edge !== null && `, edge ${edgeText(r.edge)}`}
          </small>
        </span>
        <Link className="pf-open" to={keepMode(`/verify/${r.signature}`)}>
          Open proof<span className="sr-only">: {r.eventTitle}</span>
        </Link>
      </li>
    );
  }
  const refunded = call.state === 'void';
  return (
    <li>
      <span className="status" data-outcome={refunded ? 'back' : undefined}>
        {refunded ? 'Refunded' : 'Sealed'}
      </span>
      <span className="pf-what">
        <span className="kind-tag">{kind}</span>
        Sealed {ago(call.committedAt)}
        <small>{refunded ? 'The first half failed, so it can never be revealed' : 'Not revealed'}</small>
      </span>
      {commit}
    </li>
  );
}

export default function Proof() {
  const venue = useVenue();
  const flow = useResource('flow', () => api.flow(), { live: [[execLive, 'bets']], pollMs: 10000 });
  // The same cached answers My bets and the leaderboard use.
  const calls = useResource('calls', () => api.calls(), { live: [[chainLive, 'calls']], pollMs: 15000 });
  const board = useResource('leaderboard', () => api.leaderboard(), { live: [[chainLive, 'leaderboard']], pollMs: 30000 });
  const [rec, setRec] = useState<ReconcileResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useNow(60_000); // keeps "12 min ago" current

  async function run() {
    setRunning(true);
    setErr(null);
    try {
      setRec(await api.reconcile());
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setRunning(false);
    }
  }

  const f = flow.data;
  const where = whereItRuns(venue);

  // Revealed calls first, because each has a proof page to open; then the rest. Newest first within each.
  const opens = (c: CallRecord) => (c.state === 'revealed' && c.reveal ? 0 : 1);
  const mine = [...(calls.data?.calls ?? [])].sort((a, b) => opens(a) - opens(b) || (a.committedAt < b.committedAt ? 1 : a.committedAt > b.committedAt ? -1 : 0));
  const sealedShown = mine.slice(0, CALLS_SHOWN).some((c) => c.state === 'committed');
  // Real Solana transactions exist only on devnet. Demo data and the in-memory test chain have none to open.
  const onSolana = api.mode !== 'mock' && (board.data ? board.data.network === 'devnet' : mine.some((c) => c.network === 'devnet'));
  const chainKnown = api.mode === 'mock' || board.data !== null || mine.length > 0;
  const program = onSolana ? (board.data?.program ?? null) : null;
  const authorities = onSolana ? (board.data?.authorities ?? []) : [];
  // What stands in for Solana here, for the lines that say why there is nothing to open.
  const standIn = api.mode === 'mock' ? 'These calls are demo data' : 'These calls are on a test chain';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Check our books</span>
          <h1 className="h-page">Proof</h1>
          <p className="lede">Books that tie to the cent, the orders that were sent, and calls sealed before their result. The first two are checks our server runs. The third is built so you need not take our word for it.</p>
        </div>
      </header>

      <div className="proof-grid">
        <section className="card" aria-labelledby="pf-books">
          <span className="eyebrow">Books match the account</span>
          <h2 id="pf-books" className="h-card">
            Reconcile to the cent
          </h2>
          <p>
            Our server compares every order it recorded with the exchange’s own order history, then its cash with what the account holds. {where.books}
          </p>
          <button type="button" className="btn btn-primary" onClick={run} disabled={running || venue.readOnly} aria-describedby={venue.readOnly ? 'recon-why' : undefined}>
            {running ? (
              <>
                <span className="spin" aria-hidden="true" /> Checking the books
              </>
            ) : (
              where.button
            )}
          </button>
          {venue.readOnly && (
            <p id="recon-why" className="fine">
              This needs a connected exchange account. This demo shows live prices only, so there is nothing to reconcile.
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
          {rec && (
            <p className="fine">
              Checked against {where.checked} at {new Date(rec.checkedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
              {rec.mismatches.length > 0 && ` ${rec.mismatches.length === 1 ? 'One order differs' : `${rec.mismatches.length} orders differ`} from the exchange’s record.`}
            </p>
          )}
          {rec && rec.untrackedOrders > 0 && (
            <p className="fine">
              {rec.untrackedOrders === 1 ? 'One filled order on this account was' : `${rec.untrackedOrders} filled orders on this account were`} not sent by this server. The {usd(Math.abs(rec.untrackedCashFlow))}{' '}
              {rec.untrackedCashFlow < 0 ? 'spent on' : 'brought in by'} {rec.untrackedOrders === 1 ? 'it' : 'them'} is counted above.
            </p>
          )}
          {rec && (rec.nettedCash ?? 0) > 0 && (
            <p className="fine">
              The exchange cancels a YES and a NO on the same contract against each other the moment you hold both, and pays {usd(1)} for each pair straight away. Here that is {usd(rec.nettedCash ?? 0)} on {rec.nettedContracts} contracts. It is the
              same money arriving sooner, and it is already counted above.
            </p>
          )}
          {rec && (rec.betsResolvedByHand?.length ?? 0) > 0 && (
            <p className="fine">
              {rec.betsResolvedByHand!.length === 1 ? 'One bet was' : `${rec.betsResolvedByHand!.length} bets were`} settled without a plain yes or no. What {rec.betsResolvedByHand!.length === 1 ? 'it' : 'they'} paid was read from the account and
              entered by hand, and is counted above.
            </p>
          )}
          {rec && rec.betsNeedingReview.length > 0 && (
            <p className="fine">
              {rec.betsNeedingReview.length === 1 ? 'One bet was' : `${rec.betsNeedingReview.length} bets were`} settled without a plain yes or no, and what {rec.betsNeedingReview.length === 1 ? 'it' : 'they'} paid has not been entered yet. Any
              difference above is that money.
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="pf-orders">
          <span className="eyebrow">What this account’s bets sent</span>
          <h2 id="pf-orders" className="h-card">
            Orders sent
          </h2>
          <p>{where.orders}</p>
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
                <dt>Orders filled</dt>
                <dd>{f.ordersFilled}</dd>
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
                <dt>Fees at Gemini’s rate</dt>
                <dd>{usd(f.feesAtProductionRates)}</dd>
              </div>
            </dl>
          ) : flow.error ? (
            <p className="note note-bad" role="alert">
              {friendly(flow.error)}
            </p>
          ) : (
            <div className="skeleton row-skel" />
          )}
          {f && (
            <p className="fine">
              The last figure is what the same fills would pay at Gemini’s published taker rate. {f.feesCharged > 0 ? `Fees charged here: ${usd(f.feesCharged)}.` : 'No fee was charged here.'}
            </p>
          )}
        </section>

        <section className="card wide" aria-labelledby="pf-calls">
          <span className="eyebrow">Made before the result</span>
          <h2 id="pf-calls" className="h-card">
            Commit, then reveal
          </h2>
          <ol className="how">
            <li>
              <b>When you bet</b>
              <span>The call is sealed{onSolana ? ' on Solana' : ''} under your handle. What is written is a fingerprint of the call, a hash, so it shows nothing about the bet or about you.</span>
            </li>
            <li>
              <b>After it settles</b>
              <span>If you choose, you reveal the call. A revealed call has to reproduce its fingerprint, so it cannot have been changed since it was sealed.</span>
            </li>
            <li>
              <b>Anyone can check</b>
              <span>A revealed call has a proof page that anyone can open. The leaderboard counts every sealed call beside the revealed ones, so a call left out shows.</span>
            </li>
          </ol>

          <div className="pf-check">
            <div>
              <h3 className="eyebrow">Your calls</h3>
              {calls.data === null ? (
                calls.error ? (
                  <p className="note note-bad" role="alert">
                    We could not load your calls. {friendly(calls.error)}
                  </p>
                ) : (
                  <div className="skeleton row-skel" aria-busy="true" aria-label="Loading your calls" />
                )
              ) : mine.length === 0 ? (
                <p className="pf-text">
                  You have not made a call yet. <Link to={keepMode(PRODUCTS[0]!.to)}>Place a bet</Link> and its call is sealed at once, then listed here.
                </p>
              ) : (
                <>
                  <ul className="pf-calls">
                    {mine.slice(0, CALLS_SHOWN).map((c) => (
                      <CallLine key={c.id} call={c} />
                    ))}
                  </ul>
                  <p className="fine">
                    {mine.length > CALLS_SHOWN ? `${CALLS_SHOWN} of your ${mine.length} calls, revealed ones first. ` : ''}
                    {sealedShown && 'Until a call is revealed, its record shows a fingerprint and your handle, nothing else. '}
                    You reveal a settled call from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link>.{' '}
                    {onSolana
                      ? 'On a proof page your browser reads both records from Solana and recomputes the fingerprint itself.'
                      : `${standIn}, so there are no Solana transactions to open. On Solana devnet each line links to its own transaction.`}
                  </p>
                </>
              )}
            </div>

            <div>
              <h3 className="eyebrow">The public record</h3>
              {program || authorities.length > 0 ? (
                <>
                  <p className="pf-text">
                    {program ? 'Every call goes through one program on Solana devnet, signed by our key. Both are public, with every transaction they have made.' : 'Calls are written to Solana devnet as Memos signed by our key. The key is public, with every transaction it has made.'}
                  </p>
                  <div className="pf-links">
                    {program && (
                      <a className="mono-chip link" href={explorerAddress(program)} target="_blank" rel="noreferrer">
                        Program {trunc(program, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
                      </a>
                    )}
                    {authorities.map((a) => (
                      <a key={a} className="mono-chip link" href={explorerAddress(a)} target="_blank" rel="noreferrer">
                        Signing key {trunc(a, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
                      </a>
                    ))}
                  </div>
                </>
              ) : (
                <p className="pf-text">
                  {onSolana
                    ? 'This server has not said which program or key writes its records, so there is no address to open here.'
                    : chainKnown
                      ? `${standIn}, so there is no program or key on Solana to open. On Solana devnet this links to the program and to the key that signs for us.`
                      : 'The chain service has not answered yet.'}
                </p>
              )}
              <p className="pf-text">
                <Link to={keepMode('/leaderboard')}>The leaderboard</Link> shows how many calls each player sealed beside how many they revealed{program ? ', and can read the same board from the program itself' : ''}.
              </p>
            </div>
          </div>

          <p className="fine">
            Our server signs and pays for these records, so you never touch a wallet or fees. That also means the result of a call, won or lost, is reported by our key, with the exchange’s order IDs as the evidence. The fingerprint proves only that the
            call was made first.
          </p>
        </section>
      </div>
    </div>
  );
}
