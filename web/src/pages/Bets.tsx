import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CallRecord } from '../api/types';
import { explorerTx } from '../api/types';
import { betTitle, kindOf } from '../lib/betKind';
import { CashOut } from '../components/CashOut';
import {
  basketSummary,
  canRevealCall,
  checkedWords,
  fillWords,
  filterEntries,
  finishedWords,
  groupBets,
  hasPending,
  ifItComesOff,
  isOpen,
  isPlaced,
  isSettled,
  kindLabel,
  netLabel,
  notPlacedWords,
  orderIdWords,
  orderLine,
  outcomeOf,
  partSoldWords,
  realised,
  reviewWords,
  revealedWords,
  soldCallWords,
  stakeOf,
  statusWords,
  summarize,
  unconfirmedWords,
  unprotectedWords,
  usableBets,
} from '../lib/betsView';
import type { Entry, Filter } from '../lib/betsView';
import { ago, trunc, usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useNow, useResource } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { marketHeading } from '../lib/markets';
import { PRODUCTS } from '../lib/nav';
import { keepMode, useVenue } from '../lib/venue';
import '../styles/bets.css';

const tone = (n: number) => (n > 0.004 ? 'good' : n < -0.004 ? 'bad' : '');

const FILTERS: { id: Filter; name: string }[] = [
  { id: 'all', name: 'All' },
  { id: 'open', name: 'Open' },
  { id: 'settled', name: 'Finished' },
];

/** A call sealed less than this long ago may still be on its way: the receipt seals it the moment the bet is placed. */
const SEAL_GRACE_MS = 20_000;
/** The chain service refuses to seal a call when the market closes within this long as well as after it (`too_late`), so no button offers it then. */
const SEAL_CLOSE_MS = 90_000;

/** What went wrong when a call could not be revealed or sealed, in a sentence, whatever the server said. */
function callProblem(e: unknown, doing: 'reveal' | 'seal'): string {
  if (e instanceof ApiError) {
    if (e.code === 'cashed_out') return 'This bet was sold back before its market closed. Its call can be revealed once the market has closed.';
    if (e.code === 'not_settled') return 'This market has not closed yet, so there is nothing to reveal.';
    // The chain service refuses to seal a call once the market has closed or the bet has settled: asking again cannot change it.
    if (e.code === 'too_late') return 'This market has closed, so the call can no longer be sealed.';
    if (e.status === 0) return `We could not reach the server, so the call was not ${doing === 'reveal' ? 'revealed' : 'sealed'}. Check your connection and try again.`;
  }
  return `We could not ${doing} this call. Try again in a moment.`;
}

/** Something an action on one row went wrong with: `key` is the call's id (reveal) or the bet's id (seal), so it shows on that row. */
interface RowError {
  key: string;
  message: string;
  /** True when asking again cannot change the answer (the market has closed): the row then says it once and offers no retry. */
  final?: boolean;
}

interface RowProps {
  bet: Bet;
  call: CallRecord | undefined;
  /** False until the list of calls has loaded: a bet with no call is only "not sealed" once the list is known. */
  callsKnown: boolean;
  /** The id of the call being revealed, or of the bet whose call is being sealed. */
  working: string | null;
  error: RowError | null;
  onReveal: (callId: string) => void;
  onSeal: (betId: string) => void;
  /** Called when a bet has been sold back, with a sentence saying so. Also when a sale may have gone through: the list is read again. */
  onCashedOut: (message: string) => void;
  /** Shown in a basket: the bet's number goes before it. */
  leg?: number;
}

/** The result column: what the bet paid, what it pays if it wins, or nothing yet. */
function Result({ bet }: { bet: Bet }) {
  const o = outcomeOf(bet);
  const paid = realised(bet);
  // Under a finished result: where the price ended, when the exchange said.
  const finished = finishedWords(bet);
  if (o === 'back')
    return (
      <>
        <b>{usd(0)}</b>
        <small>Stake returned</small>
      </>
    );
  if (o === 'open') {
    const p = ifItComesOff(bet);
    return (
      <>
        <b className="bl-pending">Wins {usd(p.amount)}</b>
        <small>{p.condition}</small>
      </>
    );
  }
  // A bet with only its first order in place has no win to promise: the line under the row says what it is.
  if (o === 'unprotected' || o === 'unconfirmed' || o === 'placing') return <b className="bl-none">–</b>;
  // Sold straight back: what the attempt cost, as a loss. The status chip and the line under the row say what happened.
  if (o === 'unwound' && paid) return <b className={tone(paid.pnl)}>{usdSigned(paid.pnl)}</b>;
  if (o === 'review')
    return (
      <>
        <b className={paid ? tone(paid.pnl) : 'bl-none'}>{paid ? usdSigned(paid.pnl) : '–'}</b>
        <small>{paid ? 'After the check' : 'Not known yet'}</small>
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

function BetRow({ bet, call, callsKnown, working, error, onReveal, onSeal, onCashedOut, leg }: RowProps) {
  const [open, setOpen] = useState(false);
  const o = outcomeOf(bet);
  const kind = kindOf(bet);
  const title = betTitle(bet);
  const placed = isPlaced(bet);
  const hand = bet.review?.resolved ?? null;
  const detailId = `bet-${bet.id}-orders`;
  // After a sale the cash-out controls go with the button just pressed; focus moves to the sentence that says what happened.
  const soldNote = useRef<HTMLDivElement>(null);
  const focusSold = useRef(false);
  useEffect(() => {
    if (o === 'cashed' && focusSold.current) {
      focusSold.current = false;
      soldNote.current?.focus({ preventScroll: true });
      soldNote.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [o]);
  // A sale that may have gone through takes the Cash out button away (the bet comes back "not confirmed"), so focus moves to the line that says so.
  const unconfirmedNote = useRef<HTMLDivElement>(null);
  const focusUnconfirmed = useRef(false);
  useEffect(() => {
    if (o === 'unconfirmed' && focusUnconfirmed.current) {
      focusUnconfirmed.current = false;
      unconfirmedNote.current?.focus({ preventScroll: true });
      unconfirmedNote.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [o]);
  // The same for Reveal: the button goes once the call is revealed, so focus moves to the line that says it was.
  const revealNote = useRef<HTMLDivElement>(null);
  const focusRevealed = useRef(false);
  const revealedNow = call?.state === 'revealed';
  useEffect(() => {
    if (revealedNow && focusRevealed.current) {
      focusRevealed.current = false;
      revealNote.current?.focus({ preventScroll: true });
      revealNote.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [revealedNow]);

  // A call can be revealed once it has a plain result: the bet finished won or lost, or it was sold back and its market has
  // since closed. Selling a bet early ends the bet, not the call.
  const revealable = !!call && call.state === 'committed' && canRevealCall(bet);
  // A call is sealed before the result, never after, so a bet can be sealed late only while its result is still to come.
  const noCall = callsKnown && !call && (o === 'open' || o === 'won' || o === 'lost' || o === 'cashed');
  const resultKnown = o === 'won' || o === 'lost' || (o === 'cashed' && !!bet.called);
  // A call can no longer be sealed once the market is within 90 seconds of closing, or once the chain service has said so for this
  // bet (kept, so the row does not offer the button again when another row's action clears the error).
  const [refusedLate, setRefusedLate] = useState(false);
  const finalNow = !!error && error.final === true && error.key === bet.id;
  useEffect(() => {
    if (finalNow) setRefusedLate(true);
  }, [finalNow]);
  const closesAt = bet.expiry ? Date.parse(bet.expiry) : NaN;
  const closed = Number.isFinite(closesAt) && Date.now() >= closesAt;
  const tooLate = noCall && !resultKnown && (refusedLate || finalNow || closed || (Number.isFinite(closesAt) && closesAt - Date.now() < SEAL_CLOSE_MS));
  const sealable = noCall && !resultKnown && !tooLate && Date.now() - Date.parse(bet.createdAt) > SEAL_GRACE_MS;
  const lostCall = noCall && resultKnown;
  // A refusal that is final is said by the line under the row, once; any other is shown here, right above the buttons.
  const rowError = error && !error.final && (error.key === call?.id || error.key === bet.id) ? error.message : null;
  const busy = working !== null && (working === call?.id || working === bet.id);
  const revealed = call?.state === 'revealed' && !!call.reveal;

  return (
    <div className="bl-row" data-bet={bet.id} data-outcome={o}>
      <div className="bl-line">
        <div className="bl-what">
          <div className="bl-tags">
            {leg !== undefined && <span className="bl-leg">Bet {leg}</span>}
            <span className="kind-tag">{kindLabel(kind)}</span>
          </div>
          <p className="bl-title">{title}</p>
          <p className="bl-meta">
            {/* The asset and the close in the viewer's own time, like the builders. The exchange's title (its hour is New York's) is the tooltip. */}
            <span title={bet.eventTitle}>{marketHeading({ title: bet.eventTitle, ticker: bet.eventTicker, expiry: bet.expiry })}</span>
            <span>{ago(bet.createdAt)}</span>
          </p>
        </div>
        <div className="bl-fig bl-stake">
          <span className="bl-k">Stake</span>
          {placed ? <b>{usd(stakeOf(bet))}</b> : <b className="bl-none">–</b>}
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

      {/* What became of the money first, then what became of the call. Each fact once: the chip and the result column already say
          won or lost, so a revealed call adds only when it was revealed and its edge. */}
      {o === 'cashed' && bet.cashOut && (
        <div className="bl-foot" ref={revealed ? revealNote : soldNote} tabIndex={-1}>
          <p>
            Sold for <b>{usd(bet.cashOut.proceeds)}</b> before the market closed.
          </p>
          <p>
            {soldCallWords(bet)}
            {revealed && call?.reveal ? ` ${revealedWords(call.reveal.revealedAt, call.reveal.edge)}.` : ''}
          </p>
        </div>
      )}
      {revealed && call?.reveal && o !== 'cashed' && (
        <div className="bl-foot" ref={revealNote} tabIndex={-1}>
          <p>{revealedWords(call.reveal.revealedAt, call.reveal.edge)}</p>
        </div>
      )}
      {sealable && (
        <div className="bl-foot">
          <p>Not sealed yet. Seal it before the market closes so it can be revealed later.</p>
        </div>
      )}
      {tooLate && (
        <div className="bl-foot">
          <p>{closed || refusedLate || finalNow ? 'This market has closed, so the call can no longer be sealed.' : 'This market is about to close, so the call can no longer be sealed.'}</p>
        </div>
      )}
      {lostCall && (
        <div className="bl-foot">
          <p>This call was not sealed before the result, so it cannot be revealed.</p>
        </div>
      )}
      {o === 'back' && (
        <div className="bl-foot">
          <p>The first level failed, so your stake came back. This call is not scored.</p>
        </div>
      )}
      {o === 'review' && (
        <div className="bl-foot">
          <p>{reviewWords(hand ? hand.payout : null)}</p>
        </div>
      )}
      {notPlacedWords(o, bet) && (
        <div className="bl-foot">
          <p>{notPlacedWords(o, bet)}</p>
        </div>
      )}
      {o === 'unprotected' && (
        <div className="bl-foot">
          <p>{unprotectedWords(bet)}</p>
        </div>
      )}
      {o === 'unconfirmed' && (
        <div className="bl-foot" ref={unconfirmedNote} tabIndex={-1}>
          <p>{unconfirmedWords()}</p>
        </div>
      )}
      {partSoldWords(bet) && (
        <div className="bl-foot">
          <p>{partSoldWords(bet)}</p>
        </div>
      )}
      {rowError && (
        <p className="bl-err" role="alert">
          {rowError}
        </p>
      )}

      <div className="bl-bottom">
        <button type="button" className="bl-expand" aria-expanded={open} aria-controls={detailId} aria-label={`Orders and proof, ${title}`} onClick={() => setOpen(!open)}>
          <span className="bl-caret" aria-hidden="true" />
          Orders and proof
        </button>
        {revealable && call && (
          <button
            type="button"
            className="btn btn-ghost bl-btn"
            disabled={busy}
            aria-label={`${busy ? 'Revealing' : 'Reveal on Solana'}, ${title}`}
            onClick={() => {
              focusRevealed.current = true;
              onReveal(call.id);
            }}
          >
            {busy ? 'Revealing' : 'Reveal on Solana'}
          </button>
        )}
        {sealable && (
          <button type="button" className="btn btn-ghost bl-btn" disabled={busy} aria-label={`${busy ? 'Sealing' : 'Seal it now'}, ${title}`} onClick={() => onSeal(bet.id)}>
            {busy ? 'Sealing' : 'Seal it now'}
          </button>
        )}
        {call?.state === 'revealed' && call.reveal && (
          <div className="bl-links">
            <Link to={keepMode(`/verify/${call.reveal.signature}`)} aria-label={`Call proof, ${title}`}>
              Call proof
            </Link>
            <Link to={keepMode('/leaderboard')}>Leaderboard</Link>
          </div>
        )}
        {/* Nothing to sell from here while an order of the bet has no confirmed result: selling could sell what is already sold. */}
        {(bet.status === 'open' || bet.status === 'unhedged') && o !== 'unconfirmed' && (
          <CashOut
            bet={bet}
            onDone={(message, complete) => {
              if (complete) focusSold.current = true;
              onCashedOut(message);
            }}
            onUnconfirmed={(message) => {
              focusUnconfirmed.current = true;
              onCashedOut(message);
            }}
          />
        )}
      </div>

      <div id={detailId} className="bl-detail" hidden={!open}>
        <ol className="bl-orders" aria-label="Orders">
          {bet.legs.map((l) => {
            const w = orderLine(bet, l);
            return (
              <li key={l.clientOrderId}>
                <span className="bl-k">{w.label}</span>
                <span className="bl-order">
                  <span>{w.bets}</span>
                  <span className="bl-fill">{fillWords(l, w)}</span>
                </span>
                {l.orderId ? <code className="bl-id">{orderIdWords(l.orderId)}</code> : <span className="bl-id bl-none">{orderIdWords(undefined)}</span>}
              </li>
            );
          })}
          {bet.legs.length === 0 && <li className="bl-none">No orders were sent</li>}
        </ol>
        <dl className="bl-proof">
          <div>
            <dt className="bl-k">Bet ID</dt>
            <dd>
              <code className="bl-id">{bet.id}</code>
            </dd>
          </div>
          {call && (
            <div>
              <dt className="bl-k">On Solana</dt>
              <dd>
                {call.state === 'revealed' ? 'Revealed' : call.state === 'void' ? (o === 'cashed' ? 'Not scored, the first level failed' : 'Stake back, not scored') : 'Sealed'}
                {call.network === 'devnet' ? (
                  <a className="bl-id" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
                    {trunc(call.commitSignature, 8, 6)} ↗<span className="sr-only"> (opens the explorer in a new tab)</span>
                  </a>
                ) : (
                  <code className="bl-id">{trunc(call.commitSignature, 8, 6)}</code>
                )}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

type BasketEntry = Extract<Entry, { type: 'basket' }>;

function BasketPanel({ entry, all, callFor, ...row }: { entry: BasketEntry; all: BasketEntry; callFor: (id: string) => CallRecord | undefined } & Omit<RowProps, 'bet' | 'call' | 'leg'>) {
  // The header always describes the whole basket, even when a filter shows only some of its bets.
  const s = basketSummary(all);
  return (
    <li className="bl-panel bl-basket">
      <header className="bl-bhead">
        <div>
          <span className="kind-tag">Basket</span>
          <h2 className="bl-bname">{all.name ?? `Basket of ${s.size} bets`}</h2>
          <p className="bl-meta">
            <span>Placed {ago(s.placedAt)}</span>
            <span>{s.legs === s.size ? `${s.legs} bets` : `${s.legs} of ${s.size} bets placed`}</span>
          </p>
        </div>
        <dl className="bl-bfigs">
          <div>
            <dt className="bl-k">Staked</dt>
            <dd>{usd(s.stake)}</dd>
          </div>
          <div>
            <dt className="bl-k">Finished</dt>
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
  const bets = useResource('bets', () => api.bets(), { live: [[execLive, 'bets']], pollMs: 8000 });
  const calls = useResource('calls', () => api.calls(), { live: [[chainLive, 'calls']], pollMs: 8000 });
  const venue = useVenue();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const now = useNow(30_000); // keeps "12 min ago" current
  // After Check results the button may be gone (nothing is left to check), and a button that was pressed must not hand focus to the
  // page: it goes to the sentence that says what was found.
  const noteRef = useRef<HTMLParagraphElement>(null);
  const focusNote = useRef(false);

  // One record that arrives without its levels cannot be drawn, and must not take the other bets (and their cash-out) with it.
  const list = useMemo(() => usableBets(bets.data?.bets), [bets.data]);
  const callList = calls.data?.calls;
  const callFor = (id: string): CallRecord | undefined => callList?.find((c) => c.betId === id);
  const totals = useMemo(() => summarize(list), [list]);
  const entries = useMemo(() => groupBets(list), [list]);
  const shown = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const counts: Record<Filter, number> = { all: list.length, open: list.filter(isOpen).length, settled: list.filter(isSettled).length };
  const toReveal = list.filter((b) => callList?.some((c) => c.betId === b.id && c.state === 'committed') && canRevealCall(b)).length;
  // The score on a revealed call is explained once for the page, not on every row.
  const showsEdge = !!callList?.some((c) => c.state === 'revealed' && typeof c.reveal?.edge === 'number' && list.some((b) => b.id === c.betId));

  // A bet sold back keeps a call that the market's result settles. Open bets flip to Won or Lost on their own; this is the same
  // for a sold-back one: once its market has closed, ask the executor to read the result now and then, so the person is not
  // left on "waiting" until they find Check results.
  const waitingOnMarket = useMemo(() => list.some((b) => b.status === 'cashed_out' && !b.called && (!b.expiry || Date.parse(b.expiry) <= now)), [list, now]);
  useEffect(() => {
    if (!waitingOnMarket) return;
    let alive = true;
    const id = window.setTimeout(() => {
      api.settle().then(
        (r) => {
          if (!alive || (r.settled.length === 0 && (r.called?.length ?? 0) === 0)) return;
          bets.reload();
          calls.reload();
        },
        () => undefined, // quiet: the button is still there, and its own error is shown next to it
      );
    }, 2_000);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingOnMarket, now]);

  useEffect(() => {
    if (checking || !focusNote.current || !(note || error)) return;
    focusNote.current = false;
    noteRef.current?.focus({ preventScroll: true });
    noteRef.current?.scrollIntoView({ block: 'nearest' });
  }, [checking, note, error]);

  async function check() {
    if (checking) return;
    focusNote.current = true;
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
      setError(e instanceof ApiError && e.status === 0 ? 'We could not reach the server. Check your connection and try again.' : 'We could not check results. Try again in a moment.');
    } finally {
      setChecking(false);
    }
  }

  async function reveal(callId: string) {
    setWorking(callId);
    setRowError(null);
    try {
      await api.revealCall(callId);
    } catch (e) {
      setRowError({ key: callId, message: callProblem(e, 'reveal') });
    } finally {
      // Reloaded either way: a refusal can change the call too (a call whose first level failed is marked as not counting).
      calls.reload();
      setWorking(null);
    }
  }

  async function seal(betId: string) {
    setWorking(betId);
    setRowError(null);
    try {
      await api.commitCall(betId);
    } catch (e) {
      setRowError({ key: betId, message: callProblem(e, 'seal'), final: e instanceof ApiError && e.code === 'too_late' });
    } finally {
      calls.reload();
      setWorking(null);
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
  const rowProps = { callsKnown: !!callList, working, error: rowError, onReveal: reveal, onSeal: seal, onCashedOut: cashedOut };

  return (
    <div className="page bets">
      <header className="page-head">
        <div>
          <h1 className="h-page">My bets</h1>
          <p className="lede">Each bet is a pair of orders in your own exchange account. Results arrive here when markets close.</p>
        </div>
        {/* Only while something can still change: an open bet, one being checked, or one sold back whose market has not closed. */}
        {(checkable || checking) && (
          // aria-disabled, not disabled: a button that disables itself while it works drops keyboard focus to the page.
          <button type="button" className="btn btn-ghost" onClick={check} aria-disabled={checking || undefined}>
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
        <p ref={noteRef} tabIndex={-1} className={`note ${error ? 'note-bad' : 'note-info'}`} role={error ? 'alert' : 'status'}>
          {error ?? note}
        </p>
      )}

      {loading ? (
        <div className="bl-skels" aria-busy="true" aria-label="Loading your bets">
          <div className="bl-skel bl-skel-sum" />
          <div className="bl-skel bl-skel-bar" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="bl-skel bl-skel-row" />
          ))}
        </div>
      ) : failed ? (
        <div className="bl-empty" role="alert">
          <h2 className="h-card">We could not load your bets</h2>
          <p>{friendly(bets.error)} Your bets are safe: this page only reads them.</p>
          <button type="button" className="btn btn-ghost" onClick={() => bets.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* One bet is the list beneath it: the four figures say nothing it does not, so they wait for a second. */}
          {list.length > 1 && (
            <>
              <h2 className="sr-only">Summary</h2>
              <dl className="bl-sum">
                <div>
                  <dt className="eyebrow">Bets</dt>
                  <dd>{totals.count}</dd>
                  <dd className="bl-unit">
                    {totals.open} open, {totals.settled} finished{totals.notPlaced > 0 ? `, ${totals.notPlaced} not placed` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="eyebrow">Staked</dt>
                  <dd>{usd(totals.staked)}</dd>
                  <dd className="bl-unit">Across all your bets</dd>
                </div>
                <div>
                  <dt className="eyebrow">Returned</dt>
                  <dd>{usd(totals.returned)}</dd>
                  <dd className="bl-unit">From bets that have finished</dd>
                </div>
                <div>
                  <dt className="eyebrow">Net</dt>
                  <dd className={tone(totals.net)}>{usdSigned(totals.net)}</dd>
                  <dd className="bl-unit">Finished bets only, after what they cost</dd>
                </div>
              </dl>
            </>
          )}

          {list.length === 0 ? (
            <div className="bl-empty">
              <h2 className="h-card">No bets yet</h2>
              {venue.readOnly ? (
                <p>Bets are off in this view, so there is nothing here yet.</p>
              ) : (
                <>
                  <p>A bet you place shows up here at once, with both of its orders and its result.</p>
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
                </>
              )}
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
              </div>
              {/* Said once for the whole page, not on every card. */}
              {toReveal > 0 && <p className="bl-rule">Reveal a call to add it to the leaderboard. It shows the bet and the result, not your account.</p>}
              {showsEdge && <p className="bl-rule">Edge is how far a call beat the market’s own price, per $1.</p>}
              {/* The column names sit on a row of their own above the list, not beside the filters. */}
              {shown.length > 0 && (
                <span className="bl-cols" aria-hidden="true">
                  <span>Stake</span>
                  <span>Status</span>
                  <span>Result</span>
                </span>
              )}
              {shown.length === 0 ? (
                <p className="bl-none-line">{filter === 'open' ? 'No open bets right now.' : 'No finished bets yet.'}</p>
              ) : (
                <ul className="bets-list">
                  {shown.map((e) =>
                    e.type === 'single' ? (
                      <li key={e.bet.id} className="bl-panel">
                        <BetRow bet={e.bet} call={callFor(e.bet.id)} {...rowProps} />
                      </li>
                    ) : (
                      <BasketPanel key={e.id} entry={e} all={entries.find((x): x is BasketEntry => x.type === 'basket' && x.id === e.id) ?? e} callFor={callFor} {...rowProps} />
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
