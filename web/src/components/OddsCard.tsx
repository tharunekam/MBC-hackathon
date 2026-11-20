import type { OddsBand } from '../api/types';
import { bandLabel, expectedText, oddsWords, shareText } from '../lib/odds';

/**
 * "Were the market's odds right?": every revealed call grouped by the chance the market gave it, with how many came in
 * beside how many those odds expected. The board ranks players against the market's odds, so this is the check on the
 * yardstick itself. Nothing is drawn until there is a call to count.
 */
export default function OddsCard({ bands }: { bands: OddsBand[] }) {
  const words = oddsWords(bands);
  if (!words) return null;
  return (
    <section className="lb-chain lb-odds" aria-labelledby="lb-odds-h">
      <div className="lb-chain-head">
        <div>
          <span className="eyebrow">The yardstick</span>
          <h2 id="lb-odds-h" className="h-card">
            Were the market’s odds right?
          </h2>
          <p>{words}</p>
        </div>
      </div>
      {/* A list rather than a table, so the only tables on the page are boards. */}
      <ul className="lb-odds-list">
        {bands.map((b) => {
          const share = b.calls > 0 ? b.cameIn / b.calls : 0;
          const expected = b.calls > 0 ? Math.min(1, b.expected / b.calls) : 0;
          return (
            <li key={b.from} data-empty={b.calls === 0 || undefined}>
              <span className="lb-odds-band">
                <span className="fine">The market gave</span>
                {bandLabel(b)}
              </span>
              <span className="lb-odds-meter" aria-hidden="true">
                {b.calls > 0 && (
                  <>
                    <i className="lb-odds-fill" style={{ width: `${share * 100}%` }} />
                    <i className="lb-odds-mark" style={{ left: `${expected * 100}%` }} />
                  </>
                )}
              </span>
              <span className="lb-odds-nums">
                {b.calls === 0 ? (
                  'No calls yet'
                ) : (
                  <>
                    <b>
                      {b.cameIn} of {b.calls}
                    </b>{' '}
                    came in ({shareText(b.cameIn, b.calls)}). Its odds expected {expectedText(b.expected)}.
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="lb-odds-keys fine" aria-hidden="true">
        <span>
          <i className="lb-odds-fill" /> Came in
        </span>
        <span>
          <i className="lb-odds-mark" /> What its odds expected
        </span>
      </div>
      <p className="fine">
        Only revealed calls are counted, and revealing is the player’s choice: the sealed count beside each player shows what was left out. A refunded call is not scored, so it is not counted
        here either.
      </p>
    </section>
  );
}
