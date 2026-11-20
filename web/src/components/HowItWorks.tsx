import { useEffect, useRef, useState } from 'react';

/** What the pop-up says for each page. Plain steps, in the same words the page itself uses. */
export type HowKind = 'parlay' | 'range' | 'hunch';

const COPY: Record<HowKind, { title: string; steps: [string, string][]; fine: string }> = {
  parlay: {
    title: 'How Stake Back works',
    steps: [
      ['Pick two levels', 'A first level and a target. You win if the price finishes at or above the target.'],
      ['Two orders, one bet', "Placing a bet sends two orders to your own Gemini account: one pays if the target is reached, the other pays your stake back if the price finishes below the first level."],
      ['See the cost first', 'Every quote shows your chance of winning, the fair price and what you pay per $1, so you see the gap before you bet.'],
      ['Sell back any time', 'An open bet can be sold back from My bets, at the price then.'],
    ],
    fine: 'If the price holds the first level but stops short of the target, you lose your stake. Prediction markets carry risk.',
  },
  range: {
    title: 'How Range and Breakout work',
    steps: [
      ['Pick two levels', 'A lower and a higher level, from the same market.'],
      ['Range or Breakout', 'Range wins if the price finishes between the two levels. Breakout, one switch away, wins if it finishes outside them, either way.'],
      ['Two orders, one bet', 'Each bet is two orders in your own Gemini account, one on each level.'],
      ['See the cost first', 'The quote shows your chance of winning and what you pay per $1 before anything is placed.'],
    ],
    fine: 'A bet that finishes on the wrong side of its levels loses the stake. Prediction markets carry risk.',
  },
  hunch: {
    title: 'How Hunch works',
    steps: [
      ['Say what you think', 'Move the two dials: where you think the price finishes, and how sure you are.'],
      ['We list what fits', 'Bets whose price is lower than your view says they are worth, with what each one costs.'],
      ['Open one', 'Pick a bet and it opens in its builder, already chosen. Nothing is placed until you press Place bet.'],
    ],
    fine: 'The figures use your odds, not a forecast. Any bet can lose the stake.',
  },
};

/**
 * "How it works", as a pop-up over the page you are on: nothing is left behind. A native dialog, so focus stays inside it,
 * Escape closes it, and focus returns to the link that opened it.
 */
export default function HowItWorks({ kind }: { kind: HowKind }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const copy = COPY[kind];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button type="button" className="head-link" onClick={() => setOpen(true)} aria-haspopup="dialog">
        How it works
      </button>
      <dialog
        ref={ref}
        className="how-pop"
        aria-labelledby={`how-${kind}`}
        onClose={() => setOpen(false)}
        // A click on the dimmed area (the dialog element itself, outside its panel) closes it.
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div className="howp-panel">
          <div className="howp-head">
            <h2 id={`how-${kind}`}>{copy.title}</h2>
            <button type="button" className="howp-close" onClick={() => setOpen(false)} aria-label="Close">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <ol className="howp-steps">
            {copy.steps.map(([head, body]) => (
              <li key={head}>
                <b>{head}</b>
                <span>{body}</span>
              </li>
            ))}
          </ol>
          <p className="howp-fine">{copy.fine}</p>
        </div>
      </dialog>
    </>
  );
}
