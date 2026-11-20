import { Link } from 'react-router-dom';
import { PRODUCTS } from '../lib/nav';
import Reveal from './Reveal';

/**
 * What each bet pays, drawn against where the price finishes (left to right). Each is a few lines and no data: a picture of
 * the rule, labelled as an illustration. The same colours mean the same thing everywhere in the app: amber is the stake coming
 * back, red a loss, green a win.
 */
function Figure({ id }: { id: string }) {
  if (id === 'range') {
    return (
      <svg className="fig" viewBox="0 0 240 92" role="img" aria-label="A range pays when the price finishes between two levels, and loses a little outside them">
        <line className="fig-zero" x1="8" x2="232" y1="44" y2="44" />
        <path className="fig-join" pathLength={1} d="M72,58 V14 M168,14 V58" />
        <path className="fig-lose" pathLength={1} d="M8,58 H72" />
        <path className="fig-win" pathLength={1} d="M72,14 H168" />
        <path className="fig-lose" pathLength={1} d="M168,58 H232" />
        <text className="fig-label" x="40" y="86" textAnchor="middle">
          Below
        </text>
        <text className="fig-label" x="120" y="86" textAnchor="middle">
          Between
        </text>
        <text className="fig-label" x="200" y="86" textAnchor="middle">
          Above
        </text>
      </svg>
    );
  }
  if (id === 'basket') {
    const rows = [
      { y: 6, name: 'BTC' },
      { y: 34, name: 'ETH' },
      { y: 62, name: 'SOL' },
    ];
    return (
      <svg className="fig" viewBox="0 0 240 92" role="img" aria-label="A basket is several bets, each with its own result, placed together">
        {rows.map((r) => (
          <g key={r.name}>
            <text className="fig-label" x="6" y={r.y + 17} textAnchor="start">
              {r.name}
            </text>
            <line className="fig-zero" x1="40" x2="232" y1={r.y + 12} y2={r.y + 12} />
            <path className="fig-join" pathLength={1} d={`M104,${r.y + 12} V${r.y + 22} M158,${r.y + 22} V${r.y + 2}`} />
            <path className="fig-back" pathLength={1} d={`M40,${r.y + 12} H104`} />
            <path className="fig-lose" pathLength={1} d={`M104,${r.y + 22} H158`} />
            <path className="fig-win" pathLength={1} d={`M158,${r.y + 2} H232`} />
          </g>
        ))}
      </svg>
    );
  }
  return (
    <svg className="fig" viewBox="0 0 240 92" role="img" aria-label="A Return Parlay gives the stake back if the first level fails, loses it if only the first holds, and wins if both hold">
      <line className="fig-zero" x1="8" x2="232" y1="44" y2="44" />
      <path className="fig-join" pathLength={1} d="M88,44 V70 M152,70 V14" />
      <path className="fig-back" pathLength={1} d="M8,44 H88" />
      <path className="fig-lose" pathLength={1} d="M88,70 H152" />
      <path className="fig-win" pathLength={1} d="M152,14 H232" />
      <text className="fig-label" x="48" y="86" textAnchor="middle">
        Stake back
      </text>
      <text className="fig-label" x="120" y="86" textAnchor="middle">
        Loses
      </text>
      <text className="fig-label" x="192" y="86" textAnchor="middle">
        Wins
      </text>
    </svg>
  );
}

/** The three products side by side: what each pays, in one line and one picture, and a way in. */
export default function ProductShowcase() {
  return (
    <div className="wrap">
      <Reveal className="showcase-head">
        <span className="eyebrow">Products</span>
        <h2 className="h-section">Three ways to bet on a price</h2>
        <p className="lede">Each is priced from the exchange’s own ladders and placed as real orders in your account.</p>
      </Reveal>
      <Reveal delay={100}>
        <ul className="showcase">
          {PRODUCTS.map((p, i) => (
            <li key={p.id}>
              <Link to={p.to}>
                <span className="showcase-index">0{i + 1}</span>
                <Figure id={p.id} />
                <b>{p.name}</b>
                <span className="showcase-line">{p.tagline}</span>
                <span className="showcase-go">
                  Open <span aria-hidden="true">→</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="fine showcase-note">Drawn against where the price finishes. Illustrative.</p>
      </Reveal>
    </div>
  );
}
