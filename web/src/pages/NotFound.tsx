import { Link, useLocation } from 'react-router-dom';
import { MY_BETS, PRODUCTS, TOOLS } from '../lib/nav';
import { keepMode } from '../lib/venue';

/** Where a lost visitor most likely meant to go: the three builders, then Hunch for someone who has not picked one. */
const PLACES = [...PRODUCTS.map((p) => ({ to: p.to, name: p.name, line: p.tagline })), ...TOOLS.filter((t) => t.id === 'hunch').map((t) => ({ to: t.to, name: t.name, line: 'Say where you think a price finishes and see the bets that fit' }))];

/** An address the app does not know. It says so and points at pages that exist, instead of showing the landing page under a wrong address. */
export default function NotFound() {
  const { pathname } = useLocation();
  // An address can be any length; show enough of it to recognise.
  const shown = pathname.length > 64 ? `${pathname.slice(0, 64)}…` : pathname;
  return (
    <div className="page narrow lost">
      <header className="page-head">
        <div>
          <h1 className="h-page">There is nothing at this address</h1>
          <p className="lede">
            Given has no page at <code>{shown}</code>. The link may be old or mistyped. These pages do exist:
          </p>
        </div>
      </header>
      <nav aria-label="Pages that exist">
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
          Go to the start
        </Link>
        <Link to={keepMode(MY_BETS.to)} className="btn btn-ghost">
          {MY_BETS.name}
        </Link>
      </div>
    </div>
  );
}
