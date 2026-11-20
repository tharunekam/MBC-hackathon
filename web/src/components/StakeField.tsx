import { useState } from 'react';
import type { ReactNode } from 'react';
import { usd } from '../lib/format';
import { cleanStakeText } from '../lib/stake';

interface Props {
  id: string;
  /** What is typed in the box. */
  text: string;
  /** The amount that text means, to mark the matching preset. */
  stake: number;
  onText: (text: string) => void;
  presets?: number[];
  /** The most one bet may be here, when the page knows it. Quick amounts above it are switched off. */
  max?: number | null;
  /** The line under the field: how much fits, or what the stake buys. Nothing is drawn for null. */
  note: ReactNode;
  label?: string;
  /** The box and its quick amounts cannot be used (the market has closed, a bet is on its way). */
  disabled?: boolean;
}

const DEFAULT_PRESETS = [5, 10, 25, 50];

/** What is said to a person who typed something that is not an amount. */
export const NOT_AN_AMOUNT = 'Enter an amount in dollars, like 25.';

/** What a screen reader is told about the stake: that it is not an amount, or that it is over what one bet may be. Nothing otherwise. */
export const stakeSaid = (refused: boolean, over: boolean, note: ReactNode): string => (refused ? NOT_AN_AMOUNT : over && typeof note === 'string' ? note : '');

/** What a stake box takes: digits, one dot, and the dollar sign and commas a pasted amount carries ("$1,000.50"). */
const ACCEPTED = /^[\d.,$\s]*$/;

/**
 * The stake box with its quick amounts. Typing keeps digits and one dot, to the cent, and every builder reads it the same way.
 *
 * A key that is not part of an amount (a minus, a letter) is refused and says so, instead of being dropped without a word: "-5"
 * quietly became 5 and "1e3" became 13, a different bet from the one typed. Leading zeros go ("007" is 7).
 */
export default function StakeField({ id, text, stake, onText, presets = DEFAULT_PRESETS, max, note, label = 'Stake', disabled = false }: Props) {
  const [refused, setRefused] = useState(false);
  const over = max != null && stake > max;
  const noteId = `${id}-note`;
  const shown = refused ? NOT_AN_AMOUNT : note;
  // What a screen reader is told when the stake is wrong: the line under the box appears with the keystroke, and a paragraph
  // that appears is not read out. This region is always on the page, so a change in it is.
  const said = stakeSaid(refused, over, note);
  return (
    <div className="stake">
      <label htmlFor={id}>{label}</label>
      <div className="stake-row">
        <div className="field" data-over={over || undefined}>
          <span className="field-pre">$</span>
          <input type="text"
            id={id}
            inputMode="decimal"
            autoComplete="off"
            value={text}
            disabled={disabled}
            aria-invalid={over || refused || undefined}
            aria-describedby={noteId}
            onChange={(e) => {
              const raw = e.target.value;
              if (!ACCEPTED.test(raw)) {
                setRefused(true);
                return;
              }
              setRefused(false);
              onText(cleanStakeText(raw).replace(/^0+(?=\d)/, ''));
            }}
          />
        </div>
        <div className="presets">
          {presets.map((p) => {
            const above = max != null && p > max;
            return (
              <button
                key={p}
                type="button"
                className={`chip ${stake === p ? 'is-on' : ''}`}
                aria-pressed={stake === p}
                disabled={disabled || above}
                title={above && max != null ? `Bets are capped at ${usd(max, 0)} here` : undefined}
                onClick={() => {
                  setRefused(false);
                  onText(String(p));
                }}
              >
                ${p}
              </button>
            );
          })}
        </div>
      </div>
      <p className="sr-only" role="status">
        {said}
      </p>
      {shown ? (
        <p id={noteId} className={`fine ${over || refused ? 'is-bad' : ''}`}>
          {shown}
        </p>
      ) : (
        <p id={noteId} className="sr-only" />
      )}
    </div>
  );
}
