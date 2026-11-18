import { liveApi, type Api } from './client';
import { mockApi } from './mock';

/**
 * `VITE_API_MODE=live` (or `?live` in the address bar) talks to the executor.
 * Anything else runs on the in-browser mock, which the UI labels as demo data.
 */
function pickMode(): 'mock' | 'live' {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has('live')) return 'live';
    if (q.has('mock')) return 'mock';
  } catch {
    /* no window in tests */
  }
  return import.meta.env.VITE_API_MODE === 'live' ? 'live' : 'mock';
}

export const api: Api = pickMode() === 'live' ? liveApi(import.meta.env.VITE_API_BASE ?? '/api', import.meta.env.VITE_CHAIN_BASE ?? '/chain') : mockApi();
export type { Api };
