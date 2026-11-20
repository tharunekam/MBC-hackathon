import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../lib/format';
import { closesLabel, type AssetGroup } from '../lib/markets';
import { outlookOf, pointWords, wideningWords, type OutlookPoint } from '../lib/outlook';
import OutlookChart from './OutlookChart';
import '../styles/dist.css';
import '../styles/outlook.css';

interface Props {
  groups: AssetGroup[];
  now: number;
}

interface Fan {
  group: AssetGroup;
  points: OutlookPoint[];
}

/**
 * The market's forecast for one asset across its closing times, with a way into the two bets it describes.
 *
 * The Markets table gives each ladder a line. This reads an asset's ladders together: where the middle of the market's view
 * sits at each close and how wide the view is around it. A person picks a closing time and can open a Range on that
 * close's even-chance band (the price stays inside it) or a Breakout on the same two levels (it does not).
 */
export default function Outlook({ groups, now }: Props) {
  const fans = useMemo<Fan[]>(() => groups.map((group) => ({ group, points: outlookOf(group.events, now) })).filter((f) => f.points.length > 0), [groups, now]);

  // Start on the asset with the most closing times: that is the one with a fan worth looking at.
  const fallback = useMemo(() => fans.reduce<Fan | null>((best, f) => (best === null || f.points.length > best.points.length ? f : best), null), [fans]);
  const [assetKey, setAssetKey] = useState<string | null>(null);
  const [ticker, setTicker] = useState<string | null>(null);

  const fan = fans.find((f) => f.group.key === assetKey) ?? fallback;
  if (!fan) return null;
  const { group, points } = fan;
  // A chosen close that has since passed, or belongs to another asset, falls back to the soonest.
  const point = points.find((p) => p.ticker === ticker) ?? points[0]!;

  const spoken =
    `The market’s view of ${group.label} at ${points.length === 1 ? 'its closing time' : `each of ${points.length} closing times`}. ` + points.map((p) => pointWords(p, now)).join(' ');
  const widening = wideningWords(points, now);
  const market = encodeURIComponent(point.ticker);
  const levels = point.levels;
  const pair = levels ? `&low=${encodeURIComponent(levels.low.symbol)}&high=${encodeURIComponent(levels.high.symbol)}` : '';

  return (
    <section className="card ol" aria-labelledby="ol-h">
      <div className="ol-head">
        <div>
          <span className="eyebrow">Outlook</span>
          <h2 id="ol-h" className="h-card">
            Where the market thinks {group.label} finishes
          </h2>
        </div>
        {fans.length > 1 && (
          <div className="mk-seg" role="group" aria-label="Asset">
            {fans.map((f) => (
              <button key={f.group.key} type="button" aria-pressed={f.group.key === group.key} onClick={() => setAssetKey(f.group.key)}>
                {f.group.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="ol-say">
        Every closing time has its own ladder. Side by side they draw the market’s forecast: the line is the middle of its view, the darker band holds an even chance, and the lighter band four
        chances in five.
      </p>

      <OutlookChart points={points} now={now} selected={point.ticker} onSelect={setTicker} spoken={spoken} />

      <div className="dist-keys ol-keys" aria-hidden="true">
        <span data-kind="middle">
          <i />
          Middle of the market’s view
        </span>
        <span data-kind="even">
          <i />
          Even chance
        </span>
        <span data-kind="wide">
          <i />
          Four chances in five
        </span>
      </div>

      <div className="ol-pick">
        {points.length > 1 && (
          <div className="ol-closes" role="group" aria-label="Closing time">
            {points.map((p) => (
              <button key={p.ticker} type="button" aria-pressed={p.ticker === point.ticker} onClick={() => setTicker(p.ticker)}>
                {closesLabel(p.expiry, now)}
              </button>
            ))}
          </div>
        )}
        <p className="ol-words" aria-live="polite">
          {pointWords(point, now)}
        </p>
        {widening && <p className="fine ol-widening">{widening}</p>}
        <div className="ol-acts">
          {levels && (
            <>
              <Link className="btn btn-ghost btn-sm" to={`/range?market=${market}${pair}`}>
                Bet it stays between {money(levels.low.strike)} and {money(levels.high.strike)}
              </Link>
              <Link className="btn btn-ghost btn-sm" to={`/range?market=${market}${pair}&side=out`}>
                Bet it finishes outside them
              </Link>
            </>
          )}
          <Link className="ol-own" to={`/hunch?market=${market}`}>
            Set your own view against it
          </Link>
        </div>
      </div>

      <p className="fine ol-foot">
        Read from the exchange’s own prices; nothing is modelled. The ladders give no price for this moment, so the fan opens from the middle of the soonest one. A band is missing where a
        ladder’s prices do not reach that far.
      </p>
    </section>
  );
}
