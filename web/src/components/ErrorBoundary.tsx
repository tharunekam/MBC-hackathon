import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { keepMode } from '../lib/venue';

/** A page's code that failed to download (a new release replaced it, or the connection dropped) needs a reload, not a redraw. */
export function isChunkError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed/i.test(text);
}

/**
 * Whether Try again must reload the page. A page that failed to download needs it, and so does one that has already been redrawn
 * once and failed again: the same cached answer would only crash it the same way.
 */
export const needsReload = (error: unknown, retried: boolean): boolean => retried || isChunkError(error);

/** What stands where the page was. The header, the footer and the way to every other page are still there around it. */
export function PageProblem({ error, onRetry, retried = false }: { error: unknown; onRetry: () => void; retried?: boolean }) {
  const retry = () => (needsReload(error, retried) ? window.location.reload() : onRetry());
  return (
    <div className="page narrow problem">
      <div role="alert">
        <h1 className="h-page">Something went wrong</h1>
        <p className="lede">This page could not be shown.</p>
      </div>
      <div className="row-actions">
        <button type="button" className="btn btn-primary" onClick={retry}>
          Try again
        </button>
        <Link className="btn btn-ghost" to={keepMode('/parlay')}>
          Stake Back
        </Link>
        <Link className="btn btn-ghost" to={keepMode('/bets')}>
          My bets
        </Link>
      </div>
    </div>
  );
}

interface State {
  error: unknown;
  failed: boolean;
  /** The page has been redrawn once already after failing. */
  retried: boolean;
}

/**
 * Around the routed page, inside the shell. An exception while one page draws (an odd record, a field that is missing) would
 * otherwise unmount the whole app, header and navigation included, and leave a blank screen with no way out. The shell keys the
 * page by its address, so moving to another page starts a fresh boundary.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, failed: false, retried: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true } as State;
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // For whoever opens the console. The page itself says nothing technical.
    console.error('A page failed to draw', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <PageProblem error={this.state.error} retried={this.state.retried} onRetry={() => this.setState({ error: null, failed: false, retried: true })} />;
  }
}
