import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { PRODUCTS } from '../lib/nav';
import { keepMode } from '../lib/venue';
import Reveal from './Reveal';

/** What a bet does over one stretch of finishing prices. The same colours mean the same thing everywhere in the app. */
type Kind = 'back' | 'lose' | 'win';
const WORD: Record<Kind, string> = { back: 'Stake back', lose: 'Lose', win: 'Win' };

/** A bet, read left to right along where the price finishes: each piece is a result and the share of the width it takes. */
type Pieces = readonly (readonly [Kind, number])[];
const PARLAY: Pieces = [['back', 0.36], ['lose', 0.28], ['win', 0.36]];
const RANGE: Pieces = [['lose', 0.29], ['win', 0.42], ['lose', 0.29]];
const BREAKOUT: Pieces = [['win', 0.29], ['lose', 0.42], ['win', 0.29]];

/**
 * One bet as a stepped line: a flat piece at the height of each result (above the dotted line is ahead, on it is the stake
 * back, below it is behind), joined by thin risers where the result changes. `nth` staggers the drawing-in.
 */
function Steps({ pieces, left, right, zero, swing, nth = 0 }: { pieces: Pieces; left: number; right: number; zero: number; swing: number; nth?: number }) {
  const yOf = (kind: Kind) => zero + (kind === 'win' ? -swing : kind === 'lose' ? swing : 0);
  let x = left;
  const flats = pieces.map(([kind, share]) => {
    const from = x;
    x += (right - left) * share;
    return { kind, from, to: x, y: yOf(kind) };
  });
  const risers = flats
    .slice(1)
    .map((f, i) => `M${f.from.toFixed(1)},${flats[i]!.y} V${f.y}`)
    .join(' ');
  const delay = (i: number) => ({ '--i': nth + i }) as CSSProperties;
  return (
    <g>
      <line className="fig-zero" x1={left} x2={right} y1={zero} y2={zero} />
      <path className="fig-join" pathLength={1} d={risers} style={delay(1)} />
      {flats.map((f, i) => (
        <path key={i} className={`fig-${f.kind}`} pathLength={1} d={`M${f.from.toFixed(1)},${f.y} H${f.to.toFixed(1)}`} style={delay(i)} />
      ))}
    </g>
  );
}

/** A single bet's picture, with each stretch named underneath in words, so the colours are never the only clue. */
function Shape({ pieces, label }: { pieces: Pieces; label: string }) {
  return (
    <div className="fig-box" role="img" aria-label={label}>
      <svg className="fig" viewBox="0 0 240 96" aria-hidden="true" focusable="false">
        <Steps pieces={pieces} left={8} right={232} zero={48} swing={30} />
      </svg>
      <div className="fig-labels" style={{ gridTemplateColumns: pieces.map(([, share]) => `${share}fr`).join(' ') }}>
        {pieces.map(([kind], i) => (
          <span key={i} data-kind={kind}>
            {WORD[kind]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A basket: one bet per asset, each a shape of its own. The three rows are thirds of the drawing, so the names line up with them. */
function BasketFigure() {
  const rows = [
    { name: 'BTC', pieces: PARLAY },
    { name: 'ETH', pieces: RANGE },
    { name: 'SOL', pieces: BREAKOUT },
  ];
  return (
    <div className="fig-box fig-basket" role="img" aria-label="Basket: three bets on three assets, each with its own results, placed together.">
      {/* The names sit over the left of the drawing, so it has the same box, and the same scale, as the other three. */}
      <div className="fig-plot">
        <div className="fig-names" aria-hidden="true">
          {rows.map((r, i) => (
            <span key={r.name} style={{ top: `${((16 + i * 32) / 96) * 100}%` }}>
              {r.name}
            </span>
          ))}
        </div>
        <svg className="fig" viewBox="0 0 240 96" aria-hidden="true" focusable="false">
          {rows.map((r, i) => (
            <Steps key={r.name} pieces={r.pieces} left={44} right={232} zero={16 + i * 32} swing={9} nth={i} />
          ))}
        </svg>
      </div>
      {/* A key, not column headings: each row has its own order of results, so the words are not set under the rows. */}
      <div className="fig-key" aria-hidden="true">
        {(['win', 'lose', 'back'] as const).map((kind) => (
          <span key={kind} data-kind={kind}>
            {WORD[kind]}
          </span>
        ))}
      </div>
    </div>
  );
}

function Figure({ id }: { id: string }) {
  if (id === 'basket') return <BasketFigure />;
  if (id === 'range') return <Shape pieces={RANGE} label="Range: wins if the price finishes between the two levels, loses the stake if it finishes below or above them." />;
  if (id === 'breakout') return <Shape pieces={BREAKOUT} label="Breakout: wins below the lower level or above the higher one, loses between them." />;
  return <Shape pieces={PARLAY} label="Stake Back: stake back if the first level fails, lose if only it holds, win if the target is reached." />;
}

const product = (id: string) => PRODUCTS.find((p) => p.id === id)!;

/**
 * The four shapes a bet can take. Three are pages of their own. Breakout is the Range page with its switch the other way (the
 * same two levels, the opposite result), so it is a shape here without being a tab in the nav.
 */
const SHAPES = [
  { id: 'parlay', name: product('parlay').name, to: product('parlay').to, line: 'Win if the price reaches your target, up or down. If the first level fails, you get your stake back.' },
  { id: 'range', name: product('range').name, to: product('range').to, line: 'Win if the price stays put and finishes between two levels.' },
  { id: 'breakout', name: 'Breakout', to: `${product('range').to}?side=out`, line: 'Win on a big move, finishing outside two levels. No need to pick a direction.' },
  { id: 'basket', name: product('basket').name, to: product('basket').to, line: 'Bets on several assets, placed in one step. The page shows how they move together.' },
];

/** The four shapes side by side: what each pays, in one line and one picture, and a way in. */
export default function ProductShowcase() {
  return (
    <div className="wrap">
      <Reveal className="showcase-head">
        <h2 className="h-section">Four ways to bet on a price</h2>
        <p className="h-sub">Up, down, stays put or a big move</p>
      </Reveal>
      <Reveal delay={100}>
        <ul className="showcase">
          {SHAPES.map((s) => (
            // The name is the link, stretched over the whole card, so the card is one target with a short name.
            <li key={s.id}>
              <h3 className="showcase-name">
                <Link to={keepMode(s.to)}>{s.name}</Link>
              </h3>
              <Figure id={s.id} />
              <p className="showcase-line">{s.line}</p>
              <span className="showcase-go" aria-hidden="true">
                Open
                <i>→</i>
              </span>
            </li>
          ))}
        </ul>
        <p className="fine showcase-note">Each picture shows what the bet pays against where the price finishes. Above the dotted line you are ahead, below it you are behind.</p>
      </Reveal>
    </div>
  );
}
