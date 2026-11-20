import { api } from '../api';
import { createLive } from './live';
import type { Live } from './live';

/**
 * The two shared live connections. They exist only against the real backends: in demo mode there is nothing to stream, so
 * pages fall back to polling the in-browser mock.
 */
const enabled = api.mode === 'live' && typeof EventSource !== 'undefined';
const apiBase = import.meta.env.VITE_API_BASE ?? '/api';
const chainBase = import.meta.env.VITE_CHAIN_BASE ?? '/chain';

/** Market prices and bets (the executor). */
export const execLive: Live | null = enabled ? createLive(`${apiBase}/stream`, ['markets', 'bets']) : null;
/** Calls and the leaderboard (the chain service). */
export const chainLive: Live | null = enabled ? createLive(`${chainBase}/events`, ['calls', 'leaderboard']) : null;

// A tab nobody is looking at does not need a socket. After a pause the connection reopens and every page refetches.
const HIDDEN_GRACE_MS = 30_000;
if (enabled && typeof document !== 'undefined') {
  let timer: number | undefined;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      timer = window.setTimeout(() => {
        execLive?.pause();
        chainLive?.pause();
      }, HIDDEN_GRACE_MS);
    } else {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      execLive?.resume();
      chainLive?.resume();
    }
  });
}
