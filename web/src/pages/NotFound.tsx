import { Link, useLocation } from 'react-router-dom';
import { MY_BETS, PRODUCTS, TOOLS } from '../lib/nav';
import { keepMode } from '../lib/venue';

/** Where a lost visitor most likely meant to go: the three builders, then the pages that help choose one. */
const LINES: Record<string, string> = {
  markets: 'See every market and what is on offer',
  hunch: 'Say where you think a price finishes and see the bets that fit',
};
const PLACES = [
  ...PRODUCTS.map((p) => ({ to: p.to, name: p.name, line: p.tagline })),
  ...TOOLS.filter((t) => t.id in LINES).map((t) => ({ to: t.to, name: t.name, line: LINES[t.id]! })),
];

/** An address the app does not know. It says so and points at pages that exist, instead of showing the landing page under a wrong address. */
export default function NotFound() {
  const { pathname } = useLocation();
  // An address can be any length; show enough of it to recognise.
  const shown = pathname.length > 64 ? `${pathname.slice(0, 64)}…` : pathname;
  return (
    <div className="page narrow lost">
      <header className="page-head">
        <div>
          <h1 className="h-page">We can’t find that page</h1>
          <p className="lede">
            Stakeback has nothing at <code>{shown}</code>. The link may be old or mistyped. Try one of these.
          </p>
        </div>
      </header>
      <nav aria-label="Pages to try">
        <ul className="sheet-list">
          {PLACES.map((p) => (
            <li key={p.to}>
              <Link to={keepMode(p.to)}>
                <b>{p.name}</b>
                <span>{p.line}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="row-actions">
        <Link to={keepMode('/')} className="btn btn-primary">
          Back to Stakeback
        </Link>
        <Link to={keepMode(MY_BETS.to)} className="btn btn-ghost">
          {MY_BETS.name}
        </Link>
      </div>
    </div>
  );
}
