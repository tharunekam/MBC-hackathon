import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Shell from './components/Shell';
import { keepMode } from './lib/venue';
import Parlay from './pages/Parlay';
import Landing from './pages/Landing';
import NotFound from './pages/NotFound';

// The first screens load at once; the rest are fetched when first visited, so the opening download stays small.
const Bets = lazy(() => import('./pages/Bets'));
const Range = lazy(() => import('./pages/Range'));
const Basket = lazy(() => import('./pages/Basket'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Proof = lazy(() => import('./pages/Proof'));
const Markets = lazy(() => import('./pages/Markets'));
const Hunch = lazy(() => import('./pages/Hunch'));
const Sketch = lazy(() => import('./pages/Sketch'));
const Verify = lazy(() => import('./pages/Verify'));

// Once the first screen is up and the browser is idle, fetch the other pages, so moving to them is instant and never shows
// the loading placeholder. (Safari has no requestIdleCallback, hence the timeout.)
function preloadPages(): void {
  void import('./pages/Bets');
  void import('./pages/Range');
  void import('./pages/Basket');
  void import('./pages/Leaderboard');
  void import('./pages/Proof');
  void import('./pages/Markets');
  void import('./pages/Hunch');
  void import('./pages/Sketch');
  void import('./pages/Verify');
}
if (typeof window !== 'undefined') {
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle.call(window, preloadPages, { timeout: 4000 });
  else setTimeout(preloadPages, 1500);
}

// The placeholder carries the page's own heading, so the page is never without one while its code loads.
const Pending = ({ title }: { title: string }) => (
  <div className="page narrow" aria-busy="true">
    <h1 className="sr-only">{title}</h1>
    <div className="skeleton row-skel" />
  </div>
);
const lazyPage = (el: JSX.Element, title: string) => <Suspense fallback={<Pending title={title} />}>{el}</Suspense>;

/** An old address, sent on to its new one with its query (such as ?market=) and hash intact. */
function Moved({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}

/**
 * The app was opened with `?mock` or `?live`, and that decided what it talks to for the whole visit. The shell's own links
 * carry the flag; a link elsewhere may not, so after any move that dropped it the address gets it back. Otherwise the address
 * bar would name one mode while the page ran in another, and a reload or a shared link would silently change it.
 */
function useModeInAddress(): void {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const here = pathname + search + hash;
    const kept = keepMode(here);
    if (kept !== here) navigate(kept, { replace: true });
  }, [pathname, search, hash, navigate]);
}

export default function App() {
  useModeInAddress();
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Landing />} />
        <Route path="parlay" element={<Parlay />} />
        <Route path="range" element={lazyPage(<Range />, 'Range')} />
        <Route path="basket" element={lazyPage(<Basket />, 'Basket')} />
        <Route path="bets" element={lazyPage(<Bets />, 'My bets')} />
        <Route path="markets" element={lazyPage(<Markets />, 'Markets')} />
        <Route path="hunch" element={lazyPage(<Hunch />, 'Hunch')} />
        <Route path="sketch" element={lazyPage(<Sketch />, 'Sketch')} />
        <Route path="leaderboard" element={lazyPage(<Leaderboard />, 'Leaderboard')} />
        <Route path="proof" element={lazyPage(<Proof />, 'Proof')} />
        <Route path="verify/:signature" element={lazyPage(<Verify />, 'Proof of a call')} />
        {/* The old addresses, kept so shared links and bookmarks still land. */}
        <Route path="app" element={<Moved to="/parlay" />} />
        <Route path="app/bets" element={<Moved to="/bets" />} />
        {/* An address the app does not know says so, rather than showing the landing page under it. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
