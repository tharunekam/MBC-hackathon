/**
 * Commit, reveal, ingest and score Given calls.
 *
 * Trust model, in one place:
 *  - Only memos signed by one of our authority keys are read. Anyone can write a memo; nobody else's counts.
 *  - A reveal counts only if it reproduces its commit's hash, names that commit, and is the first reveal for it.
 *  - The Stream or the backfill only tells us a signature exists. We re-read the transaction from Solana
 *    ourselves and never trust a delivered payload.
 *  - The outcome is attested by our authority (it is unknown at commit time, so no hash can cover it). The
 *    Gemini order IDs on the owner's bet are the evidence behind it.
 */
import { edge, commitHash, handleFor, newSalt } from './hash.ts';
import type { CallFields } from './hash.ts';
import type { Chain } from './chain.ts';
import { ServiceError } from './executor.ts';
import type { BetSource, ExecutorBet } from './executor.ts';
import { encode, fieldsOf, parseMemo, revealMatchesCommit } from './memo.ts';
import type { RevealMemo } from './memo.ts';
import type { CallRow, SeenReveal, Store } from './store.ts';

export interface ServiceOptions {
  chain: Chain;
  store: Store;
  bets: BetSource;
  /** Authority public keys whose memos count. Defaults to the chain's own authority. */
  authorities?: string[];
  /** Calls a player needs before they appear on the leaderboard. */
  minCalls?: number;
  /** Index our own reveals right after writing them (dev without a Stream). Off when a Stream is the source. */
  selfIngest?: boolean;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/** The shape the web app expects (see web/src/api/types.ts). */
export interface CallView {
  id: string;
  handle: string;
  betId: string;
  state: 'committed' | 'revealed' | 'void';
  commitHash: string;
  commitSignature: string;
  committedAt: string;
  network: 'devnet' | 'fake';
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

export type IngestResult = 'new' | 'duplicate' | 'ignored' | 'unverified';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export class ChainService {
  readonly chain: Chain;
  readonly store: Store;
  private readonly bets: BetSource;
  private readonly authorities: Set<string>;
  private readonly minCalls: number;
  private readonly selfIngest: boolean;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  /** One commit or reveal per bet at a time, so a double click cannot write twice. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Ingestion is serial: the Stream and the backfill can race on the same signature. */
  private ingestQueue: Promise<unknown> = Promise.resolve();

  constructor(o: ServiceOptions) {
    this.chain = o.chain;
    this.store = o.store;
    this.bets = o.bets;
    this.authorities = new Set(o.authorities ?? [o.chain.authority]);
    this.minCalls = o.minCalls ?? 1;
    this.selfIngest = o.selfIngest ?? false;
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? (() => `c${Math.random().toString(36).slice(2, 10)}`);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private locked<T>(key: string, job: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).then(job, job);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  private view(row: CallRow): CallView {
    return {
      id: row.id,
      handle: row.handle,
      betId: row.betId,
      state: row.state,
      commitHash: row.hash,
      commitSignature: row.commitSignature,
      committedAt: row.committedAt,
      network: row.network,
      reveal: row.reveal && {
        signature: row.reveal.signature,
        revealedAt: row.reveal.revealedAt,
        eventTitle: row.eventTitle,
        conditionLabel: row.conditionLabel,
        targetLabel: row.targetLabel,
        fairPriceAtEntry: row.fields.fairPrice,
        outcome: row.reveal.outcome,
        edge: row.reveal.edge,
      },
    };
  }

  private async send(memo: Parameters<typeof encode>[0]): Promise<{ signature: string; slot: number }> {
    const text = encode(memo);
    try {
      return await this.chain.sendMemo(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const broke = /insufficient|lamports|funds|0x1\b|debit an account/i.test(message);
      throw new ServiceError(502, broke ? 'chain_unfunded' : 'chain_error', broke ? 'The on-chain wallet is out of funds. Top it up and try again.' : 'Could not write to Solana right now. Nothing was recorded; try again.');
    }
  }

  // ------------------------------------------------------------------ commit

  commitCall(betId: string, user: string): Promise<CallView> {
    return this.locked(`bet:${betId}`, async () => {
      const existing = this.store.data.calls.find((c) => c.betId === betId && c.user === user);
      if (existing) return this.view(existing);

      const bet = await this.bets.getBet(betId);
      if (!bet || bet.user !== user) throw new ServiceError(404, 'unknown_bet', 'No such bet.');
      const fields = this.fieldsFromBet(bet);

      const salt = newSalt();
      const handle = handleFor(user, this.store.data.handleSecret);
      const hash = commitHash(fields, salt);
      const sent = await this.send({ g: 1, t: 'c', h: hash, u: handle, at: fields.at });

      const row: CallRow = {
        id: this.newId(),
        betId,
        user,
        handle,
        state: 'committed',
        salt,
        fields,
        hash,
        commitSignature: sent.signature,
        commitSlot: sent.slot,
        committedAt: new Date(fields.at * 1000).toISOString(),
        network: this.chain.network,
        eventTitle: bet.eventTitle,
        conditionLabel: bet.condition.label,
        targetLabel: bet.target.label,
      };
      this.store.data.calls.push(row);
      this.store.data.commits[sent.signature] = { signature: sent.signature, hash, handle, at: fields.at };
      this.store.save();
      return this.view(row);
    });
  }

  private fieldsFromBet(bet: ExecutorBet): CallFields {
    const fair = bet.offer?.fairPrice;
    const price = bet.payoffs?.conditionalPrice ?? bet.quotedPrice;
    const complete = (bet.status === 'open' || bet.status === 'settled') && bet.payoffs?.hedged === true;
    if (!complete || typeof fair !== 'number' || !(fair > 0 && fair < 1) || !Number.isFinite(price) || !(price > 0)) {
      throw new ServiceError(409, 'bet_not_eligible', 'This bet is not complete, so it cannot be recorded.');
    }
    return {
      betId: bet.id,
      event: bet.eventTicker,
      condition: bet.condition.symbol,
      target: bet.target.symbol,
      entryPrice: r6(price),
      fairPrice: r6(fair),
      at: Math.floor(this.now().getTime() / 1000),
    };
  }

  // ------------------------------------------------------------------ reveal

  revealCall(id: string, user: string): Promise<CallView> {
    const row = this.store.data.calls.find((c) => c.id === id && c.user === user);
    if (!row) throw new ServiceError(404, 'unknown_call', 'No such call.');
    return this.locked(`bet:${row.betId}`, async () => {
      if (row.state === 'revealed') return this.view(row);
      if (row.state === 'void') throw new ServiceError(409, 'void_call', 'The first half failed, so your stake came back and this call does not count.');

      const bet = await this.bets.getBet(row.betId);
      if (!bet?.settlement) throw new ServiceError(409, 'not_settled', 'This bet has not settled yet, so there is nothing to reveal.');
      if (bet.settlement.conditionResolved === 'no') {
        row.state = 'void';
        this.store.save();
        throw new ServiceError(409, 'void_call', 'The first half failed, so your stake came back and this call does not count.');
      }

      const outcome: 0 | 1 = bet.settlement.targetResolved === 'yes' ? 1 : 0;
      const f = row.fields;
      const sent = await this.send({
        g: 1, t: 'r', c: row.commitSignature, u: row.handle, b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: f.fairPrice, at: f.at, s: row.salt, o: outcome,
      });
      row.state = 'revealed';
      row.reveal = { signature: sent.signature, slot: sent.slot, revealedAt: this.now().toISOString(), outcome, edge: edge(outcome, f.fairPrice) };
      this.store.save();
      if (this.selfIngest) await this.ingest(sent.signature, 'local');
      return this.view(row);
    });
  }

  // ------------------------------------------------------------------ ingest

  /**
   * Reads one transaction from Solana and, if it is a valid Given record from our authority,
   * stores it. Safe to call any number of times for the same signature.
   */
  ingest(signature: string, via: SeenReveal['via']): Promise<IngestResult> {
    const job = this.ingestQueue.then(() => this.ingestNow(signature, via));
    this.ingestQueue = job.catch(() => undefined);
    return job;
  }

  /** Resolves when everything queued so far has been processed (used by tests and shutdown). */
  idle(): Promise<void> {
    return this.ingestQueue.then(() => undefined);
  }

  private async fetchTx(signature: string, via: SeenReveal['via']) {
    // A Stream can announce a transaction a moment before our RPC node confirms it.
    const attempts = via === 'stream' ? 4 : 1;
    for (let i = 0; i < attempts; i++) {
      const tx = await this.chain.getTx(signature);
      if (tx) return tx;
      if (i < attempts - 1) await this.sleep(500);
    }
    return null;
  }

  private async ingestNow(signature: string, via: SeenReveal['via']): Promise<IngestResult> {
    const { commits, reveals } = this.store.data;
    if (commits[signature] || reveals[signature]) return 'duplicate';

    const tx = await this.fetchTx(signature, via);
    if (!tx || !this.authorities.has(tx.signer)) return 'ignored';
    const memo = parseMemo(tx.memo);
    if (!memo) return 'ignored';

    if (memo.t === 'c') {
      commits[signature] = { signature, hash: memo.h, handle: memo.u, at: memo.at };
      this.store.save();
      return 'new';
    }

    // A reveal: find the commit it names, from our store or from the chain.
    let commit = commits[memo.c];
    if (!commit) {
      await this.ingestNow(memo.c, via);
      commit = this.store.data.commits[memo.c];
    }
    if (!commit) return 'unverified'; // not stored: a later pass retries once the commit is visible

    let reason: string | undefined;
    if (!revealMatchesCommit({ g: 1, t: 'c', h: commit.hash, u: commit.handle, at: commit.at }, memo)) reason = 'hash_mismatch';
    else if (Object.values(reveals).some((r) => r.commitSignature === memo.c && r.verified)) reason = 'duplicate_reveal';

    const f = fieldsOf(memo);
    reveals[signature] = {
      signature,
      commitSignature: memo.c,
      handle: memo.u,
      betId: f.betId,
      event: f.event,
      condition: f.condition,
      target: f.target,
      entryPrice: f.entryPrice,
      fairPrice: f.fairPrice,
      outcome: memo.o,
      edge: edge(memo.o, f.fairPrice),
      revealedAt: tx.blockTime ?? Math.floor(this.now().getTime() / 1000),
      via,
      verified: reason === undefined,
      ...(reason ? { reason } : {}),
    };
    this.store.save();
    return reason ? 'unverified' : 'new';
  }

  /**
   * Fills gaps: reads our authority's recent transactions and ingests any we have not seen. Solana Streams
   * cannot backfill and pause after repeated failed deliveries, so this is the safety net.
   */
  async backfill(limit = 100, maxPages = 5): Promise<{ scanned: number; added: number }> {
    let before: string | undefined;
    const all: string[] = [];
    for (let page = 0; page < maxPages; page++) {
      const sigs = await this.chain.recentSignatures(limit, before);
      all.push(...sigs);
      if (sigs.length < limit) break;
      before = sigs[sigs.length - 1];
    }
    let added = 0;
    for (const sig of all.reverse()) {
      // oldest first, so a commit is always seen before its reveal
      if ((await this.ingest(sig, 'rpc')) === 'new') added++;
    }
    return { scanned: all.length, added };
  }

  // ------------------------------------------------------------------ reads

  listCalls(user: string): CallView[] {
    return this.store.data.calls
      .filter((c) => c.user === user)
      .map((c) => this.view(c))
      .reverse();
  }

  leaderboard() {
    const by = new Map<string, { calls: number; wins: number; edge: number; last: number }>();
    for (const r of Object.values(this.store.data.reveals)) {
      if (!r.verified) continue;
      const cur = by.get(r.handle) ?? { calls: 0, wins: 0, edge: 0, last: 0 };
      cur.calls++;
      cur.wins += r.outcome;
      cur.edge += r.edge;
      cur.last = Math.max(cur.last, r.revealedAt);
      by.set(r.handle, cur);
    }
    const rows = [...by.entries()]
      .filter(([, v]) => v.calls >= this.minCalls)
      .map(([handle, v]) => ({
        handle,
        calls: v.calls,
        edge: Math.round(v.edge * 10_000) / 10_000,
        hitRate: v.wins / v.calls,
        lastRevealedAt: new Date(v.last * 1000).toISOString(),
      }))
      .sort((a, b) => b.edge - a.edge || b.calls - a.calls || a.handle.localeCompare(b.handle))
      .map((r, i) => ({ rank: i + 1, ...r }));
    const streamed = Object.values(this.store.data.reveals).some((r) => r.verified && r.via === 'stream');
    return { asOf: this.now().toISOString(), minCalls: this.minCalls, source: streamed ? ('quicknode-stream' as const) : ('rpc' as const), rows };
  }

  /** Re-reads a call's commit and reveal from the chain and recomputes the hash. For the verify page and for judges. */
  async verifyCall(id: string, user: string) {
    const row = this.store.data.calls.find((c) => c.id === id && c.user === user);
    if (!row) throw new ServiceError(404, 'unknown_call', 'No such call.');
    const commitTx = await this.chain.getTx(row.commitSignature);
    const commit = commitTx ? parseMemo(commitTx.memo) : null;
    const revealTx = row.reveal ? await this.chain.getTx(row.reveal.signature) : null;
    const reveal = revealTx ? parseMemo(revealTx.memo) : null;
    const commitOk = commit?.t === 'c' && commitTx !== null && this.authorities.has(commitTx.signer);
    const revealOk = reveal?.t === 'r' && revealTx !== null && this.authorities.has(revealTx.signer);
    const matches = commitOk && revealOk && commit.t === 'c' && reveal.t === 'r' && reveal.c === row.commitSignature && revealMatchesCommit(commit, reveal);
    return {
      callId: row.id,
      network: row.network,
      commit: { signature: row.commitSignature, found: commitOk, hash: commitOk && commit.t === 'c' ? commit.h : null },
      reveal: row.reveal ? { signature: row.reveal.signature, found: revealOk } : null,
      recomputedHash: revealOk && reveal.t === 'r' ? safeHash(reveal) : null,
      matches: Boolean(matches),
    };
  }

  health() {
    const reveals = Object.values(this.store.data.reveals);
    return {
      ok: true,
      service: 'given-chain',
      network: this.chain.network,
      authority: this.chain.authority,
      calls: this.store.data.calls.length,
      reveals: { total: reveals.length, verified: reveals.filter((r) => r.verified).length },
    };
  }
}

function safeHash(reveal: RevealMemo): string | null {
  try {
    return commitHash(fieldsOf(reveal), reveal.s);
  } catch {
    return null;
  }
}
