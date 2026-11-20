import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { CallRecord, ReconcileResponse } from '../api/types';
import { explorerTx } from '../api/types';
import { kindOfBetId } from '../lib/betKind';
import { kindLabel } from '../lib/betsView';
import { booksVerdict, countText, proofLinkMore, resultWord } from '../lib/callWords';
import { ago, edgeText, trunc, usd } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useNow, useResource } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { marketHeading } from '../lib/markets';
import { MY_BETS, PRODUCTS } from '../lib/nav';
import { explorerAddress } from '../lib/programBoard';
import { keepMode, useVenue } from '../lib/venue';
import type { VenueNote } from '../lib/venue';
import '../styles/bets.css'; // the product tag
import '../styles/proof.css';

/** How many of the visitor's calls the page lists. The rest are on My bets. */
const CALLS_SHOWN = 5;

/** Dollars for the books check: a difference of a fraction of a cent is nothing, and prints without a sign. */
const cash = (n: number) => usd(Math.abs(n) < 0.005 ? 0 : n);

/**
 * What the page says about where this server's bets go, in the words each card needs. Demo data and a replay place nothing, so
 * neither may read as an order on an exchange. Every other case says "the exchange" and leaves its name to whoever runs it.
 */
function whereItRuns({ kind }: VenueNote) {
  return {
    /** Ends the books card's paragraph. */
    books: kind === 'demo' ? 'This is demo data, so the check runs on demo books.' : kind === 'replay' ? 'This is a recorded session, so the check is the recorded one.' : '',
    /** Opens the orders card. */
    orders:
      kind === 'demo'
        ? 'This is demo data, so no order is sent. A live bet is two orders in your exchange account.'
        : kind === 'replay'
          ? 'This is a recorded session, so no order is placed now. These totals are as recorded.'
          : 'Each bet is two orders, and selling one back is two more. These are the totals for your account.',
    /** After a check: what it was checked against. */
    checked: kind === 'demo' ? 'demo data' : kind === 'replay' ? 'a recorded session' : 'the exchange',
  };
}

/** A fingerprint as a button: a person can copy it to compare with what the record shows. */
function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the chip still shows the start and end of it */
    }
  }
  return (
    <>
      {/* The name says what the button does while it shows the fingerprint, and follows the visible words once it says Copied. */}
      <button type="button" className="mono-chip pf-copy" onClick={copy} aria-label={copied ? undefined : `Copy fingerprint ${trunc(text, 6, 4)}`}>
        {copied ? 'Copied' : `${label} ${trunc(text, 6, 4)}`}
      </button>
      {/* The button's own text is not announced; this is, and it is there before it has anything to say. */}
      <span className="sr-only" role="status">
        {copied ? 'Fingerprint copied' : ''}
      </span>
    </>
  );
}

/**
 * One of the visitor's own calls: how it stands, which bet it is, and the thing a person can open to check it. Every line is
 * "kind, bet, then when": a revealed call and a sealed one read the same way, so a sealed row can be told apart from the next.
 */
function CallLine({ call, name }: { call: CallRecord; name: string | null }) {
  const kind = kindLabel(kindOfBetId(call.betId));
  const real = call.network === 'devnet';
  const r = call.state === 'revealed' ? call.reveal : undefined;

  if (r) {
    return (
      <li>
        {/* The same chip as on My bets: outlined, with a dot in the result's colour. */}
        <span className="bl-chip" data-outcome={r.outcome === 1 ? 'won' : r.outcome === 0 ? 'lost' : undefined}>
          {r.outcome === null ? 'Revealed' : resultWord(r.outcome)}
        </span>
        <span className="pf-what">
          <span className="kind-tag">{kind}</span>
          {name}
          <small>
            Revealed {ago(r.revealedAt)}
            {r.edge !== null && ` · edge ${edgeText(r.edge)} per $1`}
          </small>
        </span>
        <Link className="pf-act pf-open" to={keepMode(`/verify/${r.signature}`)}>
          Proof page<span className="sr-only">{proofLinkMore(r.outcome === null ? 'revealed' : resultWord(r.outcome), kind, name)}</span>
        </Link>
      </li>
    );
  }
  const back = call.state === 'void';
  // A sealed record on Solana is a transaction to open. Anywhere else there is only the fingerprint, to copy.
  const act = real ? (
    <a className="pf-act mono-chip link" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
      Sealed record {trunc(call.commitSignature, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
    </a>
  ) : (
    <span className="pf-act">
      <CopyChip text={call.commitHash} label="Fingerprint" />
    </span>
  );
  return (
    <li>
      <span className="bl-chip" data-outcome={back ? 'back' : undefined}>
        {back ? 'Stake back' : 'Sealed'}
      </span>
      <span className="pf-what">
        <span className="kind-tag">{kind}</span>
        {name}
        <small>{back ? `Made ${ago(call.committedAt)} · the first level failed, so there is nothing to reveal` : `Made ${ago(call.committedAt)} · not revealed yet`}</small>
      </span>
      {act}
    </li>
  );
}

export default function Proof() {
  const venue = useVenue();
  const flow = useResource('flow', () => api.flow(), { live: [[execLive, 'bets']], pollMs: 10000 });
  // The same cached answers My bets and the leaderboard use.
  const calls = useResource('calls', () => api.calls(), { live: [[chainLive, 'calls']], pollMs: 15000 });
  const bets = useResource('bets', () => api.bets(), { live: [[execLive, 'bets']], pollMs: 8000 });
  const board = useResource('leaderboard', () => api.leaderboard(), { live: [[chainLive, 'leaderboard']], pollMs: 30000 });
  const [rec, setRec] = useState<ReconcileResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLDivElement>(null);
  // Set when a check has finished: the effect below then moves focus to its result, once it is on the page.
  const [moveFocus, setMoveFocus] = useState(0);
  useNow(60_000); // keeps "12 min ago" current

  // The button is disabled while the books are read, which drops keyboard focus to the page. When the answer is in, focus goes to
  // it (or to the button again after a failure), unless the person has moved on to something else in the meantime.
  useEffect(() => {
    if (moveFocus === 0) return;
    const now = document.activeElement;
    if (now && now !== document.body && now !== button.current) return;
    const target = err ? button.current : (result.current ?? button.current);
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  }, [moveFocus]);

  async function run() {
    setRunning(true);
    setErr(null);
    try {
      setRec(await api.reconcile());
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setRunning(false);
      setMoveFocus((n) => n + 1);
    }
  }

  const f = flow.data;
  const where = whereItRuns(venue);
  // The line over a call is what the market is and when it closes, in the viewer's own time, as everywhere else: never the
  // exchange's own title, which gives the hour in New York time. A bet the list does not hold yet falls back to its title's asset.
  const nameOf = (call: CallRecord): string | null => {
    const bet = bets.data?.bets?.find((b) => b.id === call.betId);
    if (bet) return marketHeading({ title: bet.eventTitle, ticker: bet.eventTicker, expiry: bet.expiry });
    const title = call.reveal?.eventTitle;
    return title ? marketHeading({ title, ticker: '', expiry: null }) : null;
  };

  // Revealed calls first, because each has a proof page to open; then the rest. Newest first within each.
  const opens = (c: CallRecord) => (c.state === 'revealed' && c.reveal ? 0 : 1);
  const mine = [...(calls.data?.calls ?? [])].sort((a, b) => opens(a) - opens(b) || (a.committedAt < b.committedAt ? 1 : a.committedAt > b.committedAt ? -1 : 0));
  // Real Solana transactions exist only on Solana's test cluster. Demo data and the in-memory chain have none to open.
  const onSolana = api.mode !== 'mock' && (board.data ? board.data.network === 'devnet' : mine.some((c) => c.network === 'devnet'));
  const program = onSolana ? (board.data?.program ?? null) : null;
  const authorities = onSolana ? (board.data?.authorities ?? []) : [];
  // Where there is nothing public to open, the card that points at it is left out rather than explaining its absence.
  const hasRecord = program !== null || authorities.length > 0;
  const mismatches = rec?.mismatches ?? [];
  const byHand = rec?.betsResolvedByHand ?? [];
  const toReview = rec?.betsNeedingReview ?? [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h-page">Proof</h1>
          <p className="lede">Check that our books match the exchange to the cent, and that every call was sealed before it was revealed.</p>
        </div>
      </header>

      <div className="proof-grid">
        <section className="card" aria-labelledby="pf-books">
          <h2 id="pf-books" className="h-card">
            Check our books against the exchange
          </h2>
          <p>We compare each recorded order with the exchange’s history, then our cash with the account’s. {where.books}</p>
          <button ref={button} type="button" className="btn btn-primary" onClick={run} disabled={running || venue.readOnly} aria-describedby={venue.readOnly ? 'recon-why' : undefined}>
            {running ? (
              <>
                <span className="spin" aria-hidden="true" /> Checking the books
              </>
            ) : (
              'Check against the exchange'
            )}
          </button>
          {venue.readOnly && (
            <p id="recon-why" className="fine">
              This needs a connected exchange account, and this view shows live prices only.
            </p>
          )}
          {err && (
            <p className="note note-bad" role="alert">
              {err}
            </p>
          )}
          {!rec && !err && (
            // What the result will look like, so the card is not an empty box before the first check.
            <dl className="recon recon-4 is-idle" role="group" aria-label="What the check reports">
              {['Orders found', 'Our books say', 'Account holds', 'Difference'].map((t) => (
                <div key={t}>
                  <dt>{t}</dt>
                  <dd>–</dd>
                </div>
              ))}
            </dl>
          )}
          {/* Present from the start, empty while the books are read, so the answer is announced once when it arrives. */}
          <p className="sr-only" role="status">
            {rec && !running && !err ? booksVerdict(rec.ok, where.checked) : ''}
          </p>
          {rec && (
            <div ref={result} className="pf-result" tabIndex={-1}>
              <dl className="recon recon-4">
                <div>
                  <dt>Orders found</dt>
                  <dd>
                    {countText(rec.ordersMatched)} of {countText(rec.ordersChecked)}
                  </dd>
                </div>
                <div>
                  <dt>Our books say</dt>
                  <dd>{rec.expectedCash === null ? '–' : cash(rec.expectedCash)}</dd>
                </div>
                <div>
                  <dt>Account holds</dt>
                  <dd>{cash(rec.actualCash)}</dd>
                </div>
                <div className={rec.ok ? 'is-ok' : 'is-off'}>
                  <dt>Difference</dt>
                  <dd>
                    {rec.cashDifference === null ? '–' : cash(rec.cashDifference)}
                    <small>{rec.ok ? 'Matches' : 'Does not match'}</small>
                  </dd>
                </div>
              </dl>
            </div>
          )}
          {rec && (
            <p className="fine">
              Checked against {where.checked} at {new Date(rec.checkedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
              {mismatches.length > 0 && ` ${mismatches.length === 1 ? 'One order differs' : `${mismatches.length} orders differ`} from the exchange’s record.`}
            </p>
          )}
          {rec && rec.untrackedOrders > 0 && (
            <p className="fine">
              {rec.untrackedOrders === 1 ? 'One order on this account was' : `${rec.untrackedOrders} orders on this account were`} not sent by Stakeback. The {cash(Math.abs(rec.untrackedCashFlow))}{' '}
              {rec.untrackedCashFlow < 0 ? 'spent on' : 'brought in by'} {rec.untrackedOrders === 1 ? 'it' : 'them'} is counted above.
            </p>
          )}
          {rec && (rec.nettedCash ?? 0) > 0 && (
            <p className="fine">
              The exchange pays {usd(1)} straight away for each matching Yes and No you hold on the same market. Here that is {usd(rec.nettedCash ?? 0)} on {countText(rec.nettedContracts ?? 0)} shares. It is the same money arriving sooner, and it is
              counted above.
            </p>
          )}
          {byHand.length > 0 && (
            <p className="fine">
              {byHand.length === 1 ? 'One bet' : `${byHand.length} bets`} closed without a plain yes or no. What {plural(byHand.length, 'it', 'they')} paid was read from the account and entered by hand, and is counted above.
            </p>
          )}
          {toReview.length > 0 && (
            <p className="fine">
              {toReview.length === 1 ? 'One bet' : `${toReview.length} bets`} closed without a plain yes or no, and what {plural(toReview.length, 'it', 'they')} paid has not been entered yet. Any difference above is that money.
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="pf-orders">
          <h2 id="pf-orders" className="h-card">
            What your bets have sent
          </h2>
          <p>{where.orders}</p>
          {f ? (
            <dl className="recon recon-6">
              <div>
                <dt>Bets</dt>
                <dd>{countText(f.bets)}</dd>
              </div>
              <div>
                <dt>Orders sent</dt>
                <dd>{countText(f.ordersSent)}</dd>
              </div>
              <div>
                <dt>Orders completed</dt>
                <dd>{countText(f.ordersFilled)}</dd>
              </div>
              <div>
                <dt>Shares bought</dt>
                <dd>{(f.contracts ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</dd>
              </div>
              <div>
                <dt>Traded</dt>
                <dd>{cash(f.premium)}</dd>
              </div>
              <div>
                <dt>Fees at Gemini’s rate</dt>
                <dd>{cash(f.feesAtProductionRates)}</dd>
              </div>
            </dl>
          ) : flow.error ? (
            <div className="note note-bad pf-retry" role="alert">
              <span>{friendly(flow.error)}</span>
              <button type="button" className="btn btn-ghost" onClick={() => flow.reload()}>
                Try again
              </button>
            </div>
          ) : (
            <div className="skeleton row-skel" />
          )}
          {f && (
            <p className="fine">
              The last figure is what the same orders would cost at Gemini’s published fee rate. {f.feesCharged > 0 ? `Fees charged here: ${cash(f.feesCharged)}.` : 'No fee was charged here.'}
            </p>
          )}
        </section>

        <section className="card wide" aria-labelledby="pf-calls">
          <h2 id="pf-calls" className="h-card">
            Every call is sealed before it is revealed
          </h2>
          <ol className="how">
            <li>
              <b>When you bet</b>
              <span>Your call is sealed{onSolana ? ' on Solana' : ''} as a fingerprint that shows nothing about the bet or you.</span>
            </li>
            <li>
              <b>After the result</b>
              <span>You can reveal it. A revealed call must reproduce its fingerprint, so it cannot have changed.</span>
            </li>
            <li>
              <b>Anyone can check</b>
              <span>{onSolana ? 'A revealed call has a proof page that reads Solana and checks the seal came first.' : 'A revealed call has a proof page that anyone can open.'}</span>
            </li>
          </ol>

          <div className={`pf-check${hasRecord ? '' : ' pf-check-solo'}`}>
            <div>
              <h3 className="eyebrow">Your calls</h3>
              {calls.data === null ? (
                calls.error ? (
                  <div className="note note-bad pf-retry" role="alert">
                    <span>We could not load your calls. {friendly(calls.error)}</span>
                    <button type="button" className="btn btn-ghost" onClick={() => calls.reload()}>
                      Try again
                    </button>
                  </div>
                ) : (
                  <div className="skeleton row-skel" aria-busy="true" aria-label="Loading your calls" />
                )
              ) : mine.length === 0 ? (
                <p className="pf-text">
                  You have not made a call yet. <Link to={keepMode(PRODUCTS[0]!.to)}>Place a bet</Link> and its call is sealed at once.
                </p>
              ) : (
                <>
                  <ul className="pf-calls">
                    {mine.slice(0, CALLS_SHOWN).map((c) => (
                      <CallLine key={c.id} call={c} name={nameOf(c)} />
                    ))}
                  </ul>
                  <p className="fine">
                    {mine.length > CALLS_SHOWN ? `${CALLS_SHOWN} of your ${mine.length} calls, revealed ones first. ` : ''}
                    Reveal a closed call from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link>.{onSolana ? ' Open a call to see its record on Solana.' : ''}
                  </p>
                </>
              )}
            </div>

            {hasRecord && (
              <div>
                <h3 className="eyebrow">The public record</h3>
                <p className="pf-text">
                  {program ? 'Every call goes through one program on Solana, signed by our key. Both are public.' : 'Calls are written to Solana as signed records. The key that signs them is public.'}
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
                  {/* The explorer links go to Solana's test cluster, and the page says so right beside them. */}
                  <span className="fine">Solana devnet</span>
                </div>
                <p className="pf-text">
                  <Link to={keepMode('/leaderboard')}>Open the leaderboard</Link>
                  {program ? ' to read the same totals from the program itself.' : '.'}
                </p>
              </div>
            )}
          </div>

          <p className="fine">We pay the fees for these records, so you never need a wallet.</p>
        </section>
      </div>
    </div>
  );
}
