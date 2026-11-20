import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveStatus } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { MY_BETS, PRODUCTS, TOOLS } from '../lib/nav';
import { titleFor } from '../lib/titles';
import { keepMode, useVenue, type VenueNote } from '../lib/venue';
import '../styles/header.css';
import ErrorBoundary from './ErrorBoundary';

const Sun = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
  </svg>
);
function currentTheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);
  const flip = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('given-theme', next);
    } catch {
      /* private mode */
    }
    setTheme(next);
  };
  return (
    <button type="button" className="icon-btn" onClick={flip} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}

/** The home page's sections, in reading order. The bar lists them there instead of the app's tabs. */
const CONCEPT = [
  { hash: '#how', name: 'How it works' },
  { hash: '#cost', name: 'What it costs' },
  { hash: '#proof', name: 'The record' },
  { hash: '#products', name: 'Ways to bet' },
];

const tabClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' is-on' : ''}`;

/** At 1080px and below the tabs fold into one sheet: the products with what each one is, then everything else. */
function MenuSheet({ onPick }: { onPick: () => void }) {
  return (
    <div className="sheet" id="site-menu">
      <nav className="sheet-in" aria-label="Menu">
        <h2 className="sheet-label">Products</h2>
        <ul className="sheet-list">
          {PRODUCTS.map((p) => (
            <li key={p.id}>
              <NavLink to={keepMode(p.to)} onClick={onPick}>
                <b>{p.name}</b>
                <span>{p.tagline}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <h2 className="sheet-label">Explore</h2>
        <ul className="sheet-list sheet-plain">
          {[...TOOLS, MY_BETS].map((t) => (
            <li key={t.id}>
              <NavLink to={keepMode(t.to)} onClick={onPick}>
                {t.name}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/**
 * The one label in the bar: what, if anything, is unusual about where this copy of the app gets its prices and orders. It is a
 * button, because what it means is worth reading and a hover tooltip cannot be reached with a finger.
 */
function VenueChip({ venue }: { venue: VenueNote }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!venue.chip) return null;
  return (
    <span className="venue-wrap" ref={wrap}>
      <button ref={button} type="button" className="chip chip-quiet venue" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {venue.chip}
      </button>
      {open && (
        <p id="venue-hint" className="venue-hint">
          {venue.hint}
        </p>
      )}
    </span>
  );
}

export function Nav({ venue }: { venue: VenueNote }) {
  const { pathname, hash } = useLocation();
  const home = pathname === '/';
  const [top, setTop] = useState(true);
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const on = () => setTop(window.scrollY < 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => setMenu(false), [pathname, hash]);
  useEffect(() => {
    if (!menu) return;
    document.body.style.overflow = 'hidden';
    // The sheet covers the page, so what is behind it leaves the tab order and the reading order until it closes.
    const behind = document.querySelectorAll<HTMLElement>('#main, .tabbar, .foot');
    behind.forEach((el) => (el.inert = true));
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(false);
      menuBtn.current?.focus(); // the link that had focus is about to go, so hand it back to the button
    };
    // The sheet only exists at 1080px and below (header.css). A window widened past that with the menu open must not stay locked.
    const wide = window.matchMedia('(min-width: 1081px)');
    const widened = () => wide.matches && setMenu(false);
    document.addEventListener('keydown', esc);
    wide.addEventListener('change', widened);
    return () => {
      document.body.style.overflow = '';
      behind.forEach((el) => (el.inert = false));
      document.removeEventListener('keydown', esc);
      wide.removeEventListener('change', widened);
    };
  }, [menu]);
  return (
    // At the top of a page the bar has no edge; once the page moves under it, it gets its rule and its blur.
    <header className="nav" data-home={home ? '' : undefined} data-top={top && !menu ? '' : undefined}>
      <div className="nav-in">
        <Link to={keepMode('/')} className="brand" aria-label="Given home">
          Given
        </Link>
        {home ? (
          // On the home page the bar is the page's own contents: the idea first, then the ways to bet.
          <nav className="nav-links" aria-label="On this page">
            {CONCEPT.map((c) => (
              <Link key={c.hash} to={keepMode(`/${c.hash}`)} className="nav-link">
                {c.name}
              </Link>
            ))}
          </nav>
        ) : (
          <nav className="nav-links" aria-label="Main">
            {PRODUCTS.map((p) => (
              <NavLink key={p.id} to={keepMode(p.to)} className={tabClass}>
                {p.name}
              </NavLink>
            ))}
            <span className="nav-sep" aria-hidden="true" />
            {TOOLS.map((t) => (
              <NavLink key={t.id} to={keepMode(t.to)} className={tabClass}>
                {t.name}
              </NavLink>
            ))}
          </nav>
        )}
        <div className="nav-right">
          {/* A recorded session and made-up data are not connected to anything, so there is nothing to be live. */}
          {!home && venue.kind === 'exchange' && <LiveBadge />}
          <VenueChip venue={venue} />
          <ThemeToggle />
          {home ? (
            <Link to={keepMode(PRODUCTS[0]!.to)} className="btn btn-primary btn-sm">
              Open the app
            </Link>
          ) : (
            <NavLink to={keepMode(MY_BETS.to)} className={({ isActive }) => `btn btn-ghost btn-sm bets-link${isActive ? ' is-on' : ''}`}>
              {MY_BETS.name}
            </NavLink>
          )}
          <button ref={menuBtn} type="button" className="menu-btn" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            {menu ? 'Close' : 'Menu'}
          </button>
        </div>
      </div>
      {menu && <MenuSheet onPick={() => setMenu(false)} />}
    </header>
  );
}

/** Shows that prices and results are arriving on their own, or that the page has fallen back to refreshing. */
function LiveBadge() {
  const exec = useLiveStatus(execLive);
  const chain = useLiveStatus(chainLive);
  if (!execLive && !chainLive) return null;
  const all = [exec, chain];
  const state = all.every((s) => s === 'live') ? 'live' : all.some((s) => s === 'down') ? 'down' : all.some((s) => s === 'live') ? 'live' : 'connecting';
  if (state === 'connecting') return null; // do not flash a status before there is one
  const label = state === 'live' ? 'Live' : 'Reconnecting';
  return (
    <span className="live" data-state={state} role="status" title={state === 'live' ? 'Prices and results update as they happen.' : 'The live connection dropped. The page refreshes every few seconds until it is back.'}>
      <span className="live-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <div className="brand">Given</div>
            <p>Bet on where a price finishes. See every result before you bet.</p>
          </div>
          <nav className="foot-cols" aria-label="Footer">
            <div>
              <p className="foot-title">Products</p>
              {PRODUCTS.map((p) => (
                <Link key={p.id} to={keepMode(p.to)}>
                  {p.name}
                </Link>
              ))}
            </div>
            <div>
              <p className="foot-title">Explore</p>
              {[...TOOLS, MY_BETS].map((t) => (
                <Link key={t.id} to={keepMode(t.to)}>
                  {t.name}
                </Link>
              ))}
            </div>
            <div>
              <p className="foot-title">About</p>
              {CONCEPT.map((c) => (
                <Link key={c.hash} to={keepMode(`/${c.hash}`)}>
                  {c.name}
                </Link>
              ))}
            </div>
          </nav>
        </div>
        <p className="foot-legal">Not affiliated with Gemini. Prediction markets carry risk, including the loss of your stake.</p>
      </div>
    </footer>
  );
}

/**
 * The phone's bottom bar: the three builders, Hunch (another way to start a bet) and the place you come back to. Markets is an
 * index rather than a way in, so it sits in the Menu with Leaderboard and Proof.
 */
const TABS: { to: string; label: string }[] = [
  // Every tab shows its full name. On a phone under 350px wide "Stake Back" is wider than a fifth of the bar, so the bar gives each
  // tab the room its own name needs (app.css) rather than shortening it to "Stake", which reads as the stake box.
  ...PRODUCTS.map((p) => ({ to: p.to, label: p.name })),
  ...TOOLS.filter((t) => t.id === 'hunch').map((t) => ({ to: t.to, label: t.name })),
  { to: MY_BETS.to, label: MY_BETS.name },
];

/**
 * Layout for every route. A new page starts at the top and takes keyboard focus; a link to a section of a page lands on it, and
 * the same link clicked again lands on it again.
 */
export default function Shell() {
  const { pathname, search, hash, key } = useLocation();
  const venue = useVenue();
  const last = useRef<{ pathname: string; search: string; hash: string } | null>(null);
  useEffect(() => {
    const prev = last.current;
    last.current = { pathname, search, hash };
    // A page changing its own query (a filter, the market in view) is not a move: the scroll and the focus stay where they are.
    if (prev && prev.pathname === pathname && prev.hash === hash && prev.search !== search) return;
    const arrived = prev === null || prev.pathname !== pathname;
    // A new page appears at once. Moving about within one follows the page's own scroll-behavior, which is off for reduced motion.
    const behavior: ScrollBehavior = arrived ? 'instant' : 'auto';
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView({ behavior });
    else window.scrollTo({ top: 0, left: 0, behavior });
    // The link that was used is gone from view (or from the page), so the next Tab would start from the footer. Focus goes to the
    // page itself, unless it is the first load or the page has already put focus on something of its own.
    const main = document.getElementById('main');
    if (prev !== null && arrived && !target && main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
    // `key` is new for every navigation, including a click on the address already shown, which is how that click is told apart.
  }, [pathname, search, hash, key]);
  useEffect(() => {
    document.title = titleFor(pathname);
  }, [pathname]);
  return (
    <>
      {/* The first thing a keyboard reaches: past the bar, straight to the page. */}
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav venue={venue} />
      {/* Keyed by page, so each page eases in as it arrives, and a failure on one page ends when the person moves to another.
          Focusable only by the skip link and by a move to a new page, so focus (and a screen reader) really does move here. */}
      <main id="main" key={pathname} tabIndex={-1}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      {/* After the page in reading and tab order. It is fixed to the bottom of a phone's screen, so nothing is lost to the move. */}
      {pathname !== '/' && (
        <nav className="tabbar" aria-label="Primary">
          {TABS.map((l) => (
            <NavLink key={l.to} to={keepMode(l.to)} className={({ isActive }) => (isActive ? 'is-on' : '')}>
              {l.label}
            </NavLink>
          ))}
        </nav>
      )}
      <Footer />
    </>
  );
}
