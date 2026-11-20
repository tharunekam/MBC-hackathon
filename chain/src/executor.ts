/**
 * The chain service's view of the executor. It never trusts the browser about a bet:
 * it asks the executor, which owns the ledger and the Gemini orders.
 */

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The parts of an executor bet this service reads. */
export interface ExecutorBet {
  id: string;
  user: string;
  createdAt: string;
  eventTicker: string;
  eventTitle: string;
  condition: { symbol: string; label: string; strike: number };
  target: { symbol: string; label: string; strike: number };
  status: string;
  quotedPrice: number;
  payoffs?: { hedged: boolean; conditionalPrice: number | null };
  offer?: { fairPrice: number | null };
  settlement?: { conditionResolved: 'yes' | 'no'; targetResolved: 'yes' | 'no'; payout: number };
}

export interface BetSource {
  /** Throws if the service at the other end is not the Given executor. */
  assertExecutor(): Promise<void>;
  getBet(betId: string): Promise<ExecutorBet | null>;
}

export class ExecutorClient implements BetSource {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(base: string, fetchImpl: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  private async json(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { signal: AbortSignal.timeout(8000) });
    } catch {
      throw new ServiceError(502, 'executor_unreachable', 'Cannot reach the bet service right now.');
    }
    if (!res.ok) throw new ServiceError(502, 'executor_error', `The bet service answered ${res.status}.`);
    return res.json();
  }

  /** Something else may be listening on the port (another project's server); refuse to treat it as the executor. */
  async assertExecutor(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/health`, { signal: AbortSignal.timeout(8000) });
    } catch {
      throw new ServiceError(502, 'executor_unreachable', 'Cannot reach the bet service right now.');
    }
    // Anything that answers but is not the Given executor (another project on the same port, a 404) is fatal, not transient.
    let service: unknown = null;
    try {
      service = ((await res.json()) as { service?: unknown }).service;
    } catch {
      /* not JSON: not ours */
    }
    if (service !== 'given-executor') {
      throw new ServiceError(502, 'not_the_executor', `${this.base} is not the Given executor (it answered ${res.status} and did not identify as one).`);
    }
  }

  async getBet(betId: string): Promise<ExecutorBet | null> {
    const body = (await this.json('/bets')) as { bets?: ExecutorBet[] };
    return body.bets?.find((b) => b.id === betId) ?? null;
  }
}
