import { useEffect, useState } from 'react';
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect width="32" height="32" rx="8" className="logo-bg" />
      <path d="M9 21c0-6 3-10 7-10s7 4 7 10" fill="none" className="logo-arc" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="11" r="2.4" className="logo-dot" />
    </svg>
  );
}

const Sun = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    <button className="icon-btn" onClick={flip} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}

const LINKS = [
  { to: '/app', label: 'Build', end: true },
  { to: '/app/bets', label: 'My bets' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/proof', label: 'Proof' },
];

export function Nav() {
  return (
    <header className="nav">
      <div className="nav-in">
        <Link to="/" className="brand" aria-label="Given home">
          <Logo />
          <span>Given</span>
        </Link>
        <nav className="nav-links" aria-label="Main">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'is-on' : '')}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="nav-right">
          {api.mode === 'mock' && <span className="chip chip-quiet" title="No real orders. Start the executor and add ?live to the address to use it.">Demo data</span>}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <div>
          <div className="brand brand-foot">
            <Logo size={18} />
            <span>Given</span>
          </div>
          <p>Bets that give your money back if the first half of your hunch doesn’t happen.</p>
        </div>
        <p className="fine">
          Given uses Gemini’s prediction market API and is not affiliated with Gemini. Bets here run on Gemini’s sandbox with practice money. Prediction markets involve risk and can lose the amount you stake.
        </p>
      </div>
    </footer>
  );
}

/** Layout for every route. Scrolls to the top on navigation. */
export default function Shell() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <>
      <Nav />
      <nav className="tabbar" aria-label="Main">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'is-on' : '')}>
            {l.label}
          </NavLink>
        ))}
      </nav>
      <main id="main">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
