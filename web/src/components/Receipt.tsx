import { Link } from 'react-router-dom';
import type { Bet, CallRecord } from '../api/types';
import { explorerTx } from '../api/types';
import { kindOf } from '../lib/betKind';
import { cents, timeLeft, trunc, usd, usdSigned } from '../lib/format';
import { rangeComesBack, receiptWords } from '../lib/receiptWords';

interface Props {
  bet: Bet;
  call: CallRecord | null;
  callError: string | null;
  /** Starts another bet of the same product. */
  onAgain: () => void;
}

/** What a placed bet turned into: the two filled orders, the call recorded on Solana, and what each result pays. */
export default function Receipt({ bet, call, callError, onAgain }: Props) {
  const [first, second] = [bet.legs.find((l) => l.role === 'outcome'), bet.legs.find((l) => l.role === 'hedge')];
  const words = receiptWords(bet);
  const range = kindOf(bet).product === 'range';
  const filled = (leg: typeof first) => `${leg?.quantityFilled} contracts at ${leg?.avgPrice !== null && leg?.avgPrice !== undefined ? cents(leg.avgPrice) : '–'}`;
  // A bare "Closed. The result appears…" read as if something had gone wrong with the bet. It is the market that has closed.
  const left = timeLeft(bet.expiry);
  const closes = left === 'Closed' ? 'This market has closed' : (left ?? 'The market closes soon');

  return (
    <div className="receipt">
      <div className="q-title">
        <span className="eyebrow">Bet placed</span>
        <h2 className="q-sentence">{words.title}</h2>
      </div>

      {bet.stakeReduced && (
        <p className="note note-info">
          Only part of your {usd(bet.stakeReduced.requested)} stake was on the market at this price, so the bet is {usd(bet.cost)}. The figures below are for that size.
        </p>
      )}

      {bet.secondLegWait?.opened && (
        <p className="note note-info">
          The second order waited {(bet.secondLegWait.waitedMs / 1000).toFixed(1)} seconds for its market to start taking orders, then went in at the same price limit.
        </p>
      )}

      <ol className="steps">
        <li className="is-done">
          <span className="dot" />
          <div>
            <b>Order 1 filled</b>
            <p>
              {filled(first)} {words.first}
            </p>
            {first?.orderId && <code className="mono-chip">Order {trunc(first.orderId, 6, 4)}</code>}
          </div>
        </li>
        <li className="is-done">
          <span className="dot" />
          <div>
            <b>Order 2 filled</b>
            <p>
              {filled(second)} {words.second}. {words.secondWhy}
            </p>
            {second?.orderId && <code className="mono-chip">Order {trunc(second.orderId, 6, 4)}</code>}
          </div>
        </li>
        <li className={call ? 'is-done' : callError ? 'is-fail' : 'is-active'}>
          <span className="dot" />
          <div>
            <b>{call ? 'Call recorded on Solana' : callError ? 'Could not record the call' : 'Recording your call on Solana'}</b>
            <p>{callError ?? 'A fingerprint of this call, not the details, so you can prove later that you made it first.'}</p>
            {call &&
              (call.network === 'devnet' ? (
                <a className="mono-chip link" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
                  {trunc(call.commitSignature, 8, 6)} ↗
                </a>
              ) : (
                <code className="mono-chip">{trunc(call.commitSignature, 8, 6)} · test chain</code>
              ))}
          </div>
        </li>
      </ol>

      <ul className="outcomes">
        {words.outcomes.map((o) => (
          <li key={o.kind} data-kind={o.kind}>
            <span>{o.label}</span>
            <b>{o.kind === 'back' ? 'Stake back' : usdSigned(o.kind === 'win' ? (bet.payoffs?.ifBothHit ?? 0) : (bet.payoffs?.ifConditionOnly ?? -bet.cost))}</b>
          </li>
        ))}
      </ul>
      {range && <p className="fine">{rangeComesBack(usd(Math.min(first?.quantityFilled ?? 0, second?.quantityFilled ?? 0)), true)} The rest depends on where it finishes.</p>}

      <p className="fine next-step">
        {closes}. The result appears on My bets by itself, and you do not need to keep this page open.
      </p>

      <div className="row-actions">
        <Link className="btn btn-primary" to="/bets">
          See my bets
        </Link>
        <button className="btn btn-ghost" onClick={onAgain}>
          Make another
        </button>
      </div>
    </div>
  );
}
