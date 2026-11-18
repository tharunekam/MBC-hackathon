// The service's own rules and private state: which bets get committed, when a
// call may be revealed, and the salts that open the commitments. What it
// returns follows CallRecord in web/src/api/types.ts.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { detailsFor, type Bet, type BetSource } from './bets.ts';
import { ChainError, type ChainApi } from './chain.ts';
import { PRICE_ONE, commitHash, type CallDetails } from './codec.ts';

/** An answer the web app shows as written: `{ error, code }` with this HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type CallState = 'committed' | 'revealed' | 'void';

export interface CallView {
  id: string;
  /** Pseudonymous: a salted hash of the executor's user name, never a Gemini account id. */
  handle: string;
  betId: string;
  state: CallState;
  commitHash: string;
  commitSignature: string;
  committedAt: string;
  /** Present once the user reveals. */
  reveal?: {
    signature: string;
    revealedAt: string;
    eventTitle: string;
    conditionLabel: string;
    targetLabel: string;
    fairPriceAtEntry: number;
    outcome: 0 | 1;
    edge: number;
  };
}

interface StoredCall extends CallView {
  user: string;
  /** Opens the commitment. Private until the call is revealed; if it is lost the call can never be. */
  salt: string;
  details: Omit<CallDetails, 'placedAt' | 'expiry'> & { placedAt: number; expiry: number };
  labels: { eventTitle: string; conditionLabel: string; targetLabel: string };
  /** True until the commit transaction is known to have landed. */
  pending?: boolean;
}

const view = ({ user: _user, salt: _salt, details: _details, labels: _labels, pending: _pending, ...shown }: StoredCall): CallView => shown;
const chainDetails = (d: StoredCall['details']): CallDetails => ({ ...d, placedAt: BigInt(d.placedAt), expiry: BigInt(d.expiry) });

/** The calls this service has committed, in one JSON file. Not for git: it holds the salts. */
export class CallStore {
  private readonly file: string | undefined;
  private readonly calls = new Map<string, StoredCall>();
  readonly handleSalt: string;

  constructor(file?: string, handleSalt?: string) {
    this.file = file;
    let saved: { handleSalt?: string; calls?: StoredCall[] } = {};
    if (file && existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')) as typeof saved;
    for (const c of saved.calls ?? []) this.calls.set(c.id, c);
    this.handleSalt = handleSalt ?? saved.handleSalt ?? randomBytes(32).toString('hex');
    if (file && saved.handleSalt !== this.handleSalt) this.write();
  }

  private write(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, handleSalt: this.handleSalt, calls: [...this.calls.values()] }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  save(call: StoredCall): void {
    this.calls.set(call.id, call);
    this.write();
  }

  all(): StoredCall[] {
    return [...this.calls.values()];
  }

  byId(id: string): StoredCall | undefined {
    return this.calls.get(id);
  }

  byBet(betId: string): StoredCall | undefined {
    return this.all().find((c) => c.betId === betId);
  }
}

const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clever', 'cosmic', 'dusty', 'eager', 'early', 'fuzzy', 'gentle', 'golden', 'hidden',
  'humble', 'icy', 'jolly', 'keen', 'lively', 'lucky', 'mellow', 'misty', 'nimble', 'noble', 'plucky', 'quiet',
  'rapid', 'rustic', 'silent', 'steady', 'sunny', 'swift', 'tidy', 'vivid',
];
const ANIMALS = [
  'badger', 'bison', 'crane', 'dingo', 'falcon', 'ferret', 'finch', 'gecko', 'heron', 'ibex', 'jackal', 'koala',
  'lemur', 'lynx', 'marten', 'mole', 'newt', 'ocelot', 'osprey', 'otter', 'panda', 'puffin', 'quail', 'raven',
  'robin', 'seal', 'shrew', 'stoat', 'tapir', 'toucan', 'walrus', 'wombat',
];

/** The same user always gets the same handle; without the salt a handle cannot be traced back. */
export function handleFor(user: string, salt: string): string {
  const h = createHmac('sha256', salt).update(user).digest();
  return `${ADJECTIVES[h[0]! % ADJECTIVES.length]}-${ANIMALS[h[1]! % ANIMALS.length]}-${10 + (h[2]! % 90)}`;
}

export interface CallServiceOptions {
  store: CallStore;
  /** Null when no Solana endpoint is configured: reads still work, writes answer 503. */
  chain: ChainApi | null;
  bets: BetSource;
  now?: () => Date;
  log?: (line: string) => void;
}

export class CallService {
  private readonly o: CallServiceOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly reported = new Set<string>();

  constructor(options: CallServiceOptions) {
    this.o = options;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** One transaction at a time: the same bet is never committed twice by racing requests. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private chain(): ChainApi {
    if (!this.o.chain) {
      throw new ApiError(503, 'chain_unavailable', 'The Solana connection is not set up, so calls cannot be recorded right now.');
    }
    return this.o.chain;
  }

  private async bets(): Promise<Bet[]> {
    try {
      return await this.o.bets.list();
    } catch {
      throw new ApiError(502, 'executor_unreachable', 'Cannot reach the executor to look up the bet.');
    }
  }

  private static failure(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof ChainError && err.code === 'NotExpiredYet') {
      return new ApiError(409, 'not_settled', 'This bet has not settled yet, so there is nothing to reveal.');
    }
    return new ApiError(502, 'chain_error', `Solana did not accept the record: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** Commits a filled bet: a salted hash goes on chain and nothing else. Safe to repeat. */
  commit(betId: string): Promise<CallView> {
    return this.serial(async () => {
      const { store } = this.o;
      let call = store.byBet(betId);
      if (call && !call.pending) return view(call);
      const chain = this.chain();

      if (!call) {
        const bet = (await this.bets()).find((b) => b.id === betId);
        if (!bet) throw new ApiError(404, 'not_found', 'No such bet.');
        const handle = handleFor(bet.user, store.handleSalt);
        const mapped = detailsFor(bet, handle);
        if (!mapped.ok) throw new ApiError(409, mapped.code, mapped.reason);
        const details = mapped.value;
        if (Number(details.expiry) * 1000 <= this.now().getTime()) {
          throw new ApiError(409, 'too_late', "This bet's event has already closed, so the call can no longer be recorded.");
        }
        const salt = randomBytes(32).toString('hex');
        const hash = commitHash(details, salt);
        call = {
          // Random, not derived from the public hash: an id cannot be guessed from the chain.
          id: randomBytes(8).toString('hex'),
          handle,
          betId,
          state: 'committed',
          commitHash: hash,
          commitSignature: '',
          committedAt: '',
          user: bet.user,
          salt,
          details: { ...details, placedAt: Number(details.placedAt), expiry: Number(details.expiry) },
          labels: {
            eventTitle: bet.eventTitle ?? bet.eventTicker,
            conditionLabel: bet.condition.label ?? bet.condition.symbol,
            targetLabel: bet.target.label ?? bet.target.symbol,
          },
          pending: true,
        };
        // Saved before the transaction: a commitment whose salt was lost can never be opened.
        store.save(call);
      }

      try {
        // If an earlier attempt stopped between sending and saving, the record is already on chain.
        call.commitSignature = (await chain.call(call.commitHash))
          ? ((await chain.lastSignature(call.commitHash)) ?? '')
          : await chain.commit(call.commitHash);
      } catch (err) {
        throw CallService.failure(err);
      }
      delete call.pending;
      call.committedAt = this.now().toISOString();
      store.save(call);
      this.o.log?.(`committed ${call.id} for bet ${betId} ${call.commitSignature}`);
      return view(call);
    });
  }

  /** Publishes a call. Only for a bet that settled with its condition held. Safe to repeat. */
  reveal(callId: string): Promise<CallView> {
    return this.serial(async () => {
      const { store } = this.o;
      const call = store.byId(callId);
      if (!call || call.pending) throw new ApiError(404, 'not_found', 'No such call.');
      if (call.state === 'revealed') return view(call);

      const bet = (await this.bets()).find((b) => b.id === call.betId);
      if (!bet) throw new ApiError(404, 'not_found', 'The bet behind this call is no longer in the ledger.');
      if (bet.status === 'needs_review') {
        throw new ApiError(409, 'not_scorable', 'Gemini did not settle this event as a clean yes or no, so this call is not scored.');
      }
      if (bet.status !== 'settled' || !bet.settlement) {
        throw new ApiError(409, 'not_settled', 'This bet has not settled yet, so there is nothing to reveal.');
      }
      if (bet.settlement.conditionResolved === 'no') {
        if (call.state !== 'void') store.save({ ...call, state: 'void' });
        throw new ApiError(409, 'void_call', 'The condition failed, so this call was refunded and does not count.');
      }

      const chain = this.chain();
      const details = chainDetails(call.details);
      let targetHit = bet.settlement.targetResolved === 'yes';
      let signature: string;
      try {
        const onChain = await chain.call(call.commitHash);
        if (onChain?.state === 'revealed') {
          // An earlier attempt landed but was not saved: the chain's result stands.
          targetHit = onChain.targetHit;
          signature = (await chain.lastSignature(call.commitHash)) ?? '';
        } else {
          signature = await chain.reveal(details, call.salt, targetHit);
        }
      } catch (err) {
        throw CallService.failure(err);
      }

      const outcome = targetHit ? 1 : 0;
      call.state = 'revealed';
      call.reveal = {
        signature,
        revealedAt: this.now().toISOString(),
        ...call.labels,
        fairPriceAtEntry: details.fairPrice / PRICE_ONE,
        outcome,
        edge: (outcome * PRICE_ONE - details.fairPrice) / PRICE_ONE,
      };
      store.save(call);
      this.o.log?.(`revealed  ${call.id} for bet ${call.betId} ${signature}`);
      return view(call);
    });
  }

  get(callId: string): CallView | null {
    const call = this.o.store.byId(callId);
    return call && !call.pending ? view(call) : null;
  }

  /** Calls newest first, for one executor user or for all. Marks calls whose condition has since failed as void. */
  async list(user?: string): Promise<CallView[]> {
    let bets: Bet[] = [];
    try {
      bets = await this.o.bets.list();
    } catch {
      // The executor being down must not hide calls that are already recorded.
    }
    const failed = new Set(bets.filter((b) => b.settlement?.conditionResolved === 'no').map((b) => b.id));
    for (const call of this.o.store.all()) {
      if (call.state === 'committed' && !call.pending && failed.has(call.betId)) this.o.store.save({ ...call, state: 'void' });
    }
    return this.o.store
      .all()
      .filter((c) => !c.pending && (user === undefined || c.user === user))
      .sort((a, b) => b.committedAt.localeCompare(a.committedAt))
      .map(view);
  }

  /**
   * One pass over the executor's bets: commits every filled bet that has no
   * call yet (bets placed outside the web app included) and, for users who
   * opted in up front, reveals calls whose bets have settled.
   */
  async sync(opts: { autoCommit: boolean; autoRevealUsers?: ReadonlySet<string> }): Promise<{ committed: number; revealed: number }> {
    const done = { committed: 0, revealed: 0 };
    if (!this.o.chain) return done;
    const bets = await this.o.bets.list();
    const attempt = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        return true;
      } catch (err) {
        const line = `${key}: ${err instanceof Error ? err.message : String(err)}`;
        if (!this.reported.has(line)) this.o.log?.(`skipped ${line}`);
        this.reported.add(line);
        return false;
      }
    };
    if (opts.autoCommit) {
      for (const bet of bets) {
        if (bet.status !== 'open' && bet.status !== 'unhedged') continue;
        const existing = this.o.store.byBet(bet.id);
        if (existing && !existing.pending) continue;
        if (await attempt(`commit ${bet.id}`, () => this.commit(bet.id))) done.committed++;
      }
    }
    const settled = new Map(bets.filter((b) => b.status === 'settled' && b.settlement).map((b) => [b.id, b]));
    for (const call of this.o.store.all()) {
      if (call.state !== 'committed' || call.pending || !opts.autoRevealUsers?.has(call.user)) continue;
      if (settled.get(call.betId)?.settlement?.conditionResolved !== 'yes') continue;
      if (await attempt(`reveal ${call.id}`, () => this.reveal(call.id))) done.revealed++;
    }
    return done;
  }
}
