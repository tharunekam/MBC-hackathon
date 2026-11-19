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
import { ChainError } from './chain.ts';
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
  /** Where the real cause of a failed write goes (the API message is deliberately generic). Default: stderr. */
  log?: (line: string) => void;
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

/** What changed: `calls` (a call was committed, revealed or voided) or `leaderboard` (a verified reveal was recorded). */
export type ChangeTopic = 'calls' | 'leaderboard';

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
  private readonly log: (line: string) => void;
  /** One commit or reveal per bet at a time, so a double click cannot write twice. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Ingestion is serial: the Stream and the backfill can race on the same signature. */
  private ingestQueue: Promise<unknown> = Promise.resolve();
  /** Recently fetched, confirmed transactions that cannot be Given records. Bounded and not persisted. */
  private readonly irrelevantTransactions = new Set<string>();
  private readonly listeners: Array<(topic: ChangeTopic) => void> = [];

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
    this.log = o.log ?? ((line) => console.error(line));
  }

  /** Called after every change a page could show. The service itself never depends on anyone listening. */
  onChange(fn: (topic: ChangeTopic) => void): void {
    this.listeners.push(fn);
  }

  private changed(topic: ChangeTopic): void {
    for (const fn of this.listeners) {
      try {
        fn(topic);
      } catch (err) {
        this.log(`[chain] a change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
      state: row.state as CallView['state'],
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
      this.log(`[chain] write failed: ${message}`);
      const broke = err instanceof ChainError ? err.kind === 'unfunded' : /insufficient|lamports|funds|0x1\b|debit an account/i.test(message);
      throw new ServiceError(502, broke ? 'chain_unfunded' : 'chain_error', broke ? 'The on-chain wallet is out of funds. Top it up and try again.' : 'Could not write to Solana right now. Nothing was recorded; try again.');
    }
  }

  // ------------------------------------------------------------------ commit

  commitCall(betId: string, user: string): Promise<CallView> {
    return this.locked(`bet:${betId}`, async () => {
      let row = this.store.data.calls.find((c) => c.betId === betId && c.user === user);
      if (row && row.state !== 'pending') return this.view(row);

      if (!row) {
        const bet = await this.bets.getBet(betId);
        if (!bet || bet.user !== user) throw new ServiceError(404, 'unknown_bet', 'No such bet.');
        const fields = this.fieldsFromBet(bet);
        const salt = newSalt();
        const handle = handleFor(user, this.store.data.handleSecret);
        row = {
          id: this.newId(),
          betId,
          user,
          handle,
          state: 'pending',
          salt,
          fields,
          hash: commitHash(fields, salt),
          commitSignature: '',
          commitSlot: 0,
          committedAt: new Date(fields.at * 1000).toISOString(),
          network: this.chain.network,
          eventTitle: bet.eventTitle,
          conditionLabel: bet.condition.label,
          targetLabel: bet.target.label,
        };
        // The salt is written BEFORE the transaction is sent. A crash, a timeout or a lost reply after the transaction
        // lands then cannot lose it: a commit whose salt is gone can never be revealed.
        this.store.data.calls.push(row);
        this.store.save();
      } else if (await this.promoteIfLanded(row)) {
        return this.view(row); // an earlier attempt landed on chain but was never recorded here: adopt it, do not write twice
      }

      // A failure leaves the row pending, with the same salt and time, so a retry produces the same hash.
      const sent = await this.send({ g: 1, t: 'c', h: row.hash, u: row.handle, at: row.fields.at });
      row.state = 'committed';
      row.commitSignature = sent.signature;
      row.commitSlot = sent.slot;
      this.store.data.commits[sent.signature] = { signature: sent.signature, hash: row.hash, handle: row.handle, at: row.fields.at };
      this.store.save();
      this.changed('calls');
      return this.view(row);
    });
  }

  /**
   * With the program, a call has its own account on chain, so "did my commit or reveal land?" is one lookup, however
   * long ago it happened and whether or not recent history can be read. Every signature found goes through the same
   * verification as any other record. Without the program this does nothing and the history scan below is the way.
   */
  private async readOwnRecord(row: CallRow): Promise<void> {
    if (!this.chain.recordsFor) return;
    try {
      for (const signature of await this.chain.recordsFor(row.hash)) await this.ingest(signature, 'rpc');
    } catch (err) {
      this.log(`[chain] could not read the on-chain record of a call: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The commit for this pending row is on chain already (a previous attempt landed). If so, mark it committed. */
  private async promoteIfLanded(row: CallRow): Promise<boolean> {
    const find = () => Object.values(this.store.data.commits).find((c) => c.hash === row.hash && c.handle === row.handle);
    let seen = find();
    if (!seen) {
      await this.readOwnRecord(row);
      seen = find();
    }
    if (!seen) {
      try {
        await this.backfill(50, 3);
      } catch (err) {
        this.log(`[chain] could not check the chain for a pending commit: ${err instanceof Error ? err.message : String(err)}`);
      }
      seen = find();
    }
    if (!seen) return false;
    row.state = 'committed';
    row.commitSignature = seen.signature;
    this.store.save();
    this.changed('calls');
    return true;
  }

  /** Marks every pending row whose commit has since been seen on chain. Returns how many were promoted. */
  recoverPending(): number {
    let n = 0;
    for (const row of this.store.data.calls) {
      if (row.state !== 'pending') continue;
      const seen = Object.values(this.store.data.commits).find((c) => c.hash === row.hash && c.handle === row.handle);
      if (!seen) continue;
      row.state = 'committed';
      row.commitSignature = seen.signature;
      n++;
    }
    if (n > 0) {
      this.store.save();
      this.changed('calls');
    }
    return n;
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
      if (row.state === 'pending') throw new ServiceError(409, 'commit_pending', 'This call is still being recorded. Try again in a moment.');
      if (row.state === 'void') throw new ServiceError(409, 'void_call', 'The first half failed, so your stake came back and this call does not count.');

      // An earlier reveal may have landed without being recorded here. Adopt it instead of writing (or being refused) twice.
      if (await this.adoptReveal(row, row.revealing === true)) return this.view(row);

      const bet = await this.bets.getBet(row.betId);
      if (!bet?.settlement) throw new ServiceError(409, 'not_settled', 'This bet has not settled yet, so there is nothing to reveal.');
      if (bet.settlement.conditionResolved === 'no') {
        row.state = 'void';
        this.store.save();
        this.changed('calls');
        throw new ServiceError(409, 'void_call', 'The first half failed, so your stake came back and this call does not count.');
      }

      const outcome: 0 | 1 = bet.settlement.targetResolved === 'yes' ? 1 : 0;
      const f = row.fields;
      row.revealing = true; // sent-or-not is unknown from here until we hear back; the next attempt checks the chain first
      this.store.save();
      const sent = await this.send({
        g: 1, t: 'r', c: row.commitSignature, u: row.handle, b: f.betId, e: f.event, k: f.condition, x: f.target, p: f.entryPrice, f: f.fairPrice, at: f.at, s: row.salt, o: outcome,
      });
      row.state = 'revealed';
      delete row.revealing;
      row.reveal = { signature: sent.signature, slot: sent.slot, revealedAt: this.now().toISOString(), outcome, edge: edge(outcome, f.fairPrice) };
      this.store.save();
      this.changed('calls');
      if (this.selfIngest) await this.ingest(sent.signature, 'local');
      return this.view(row);
    });
  }

  private async adoptReveal(row: CallRow, checkChain: boolean): Promise<boolean> {
    const find = () => Object.values(this.store.data.reveals).find((r) => r.commitSignature === row.commitSignature && r.verified);
    let seen = find();
    if (!seen && checkChain) {
      await this.readOwnRecord(row);
      seen = find();
    }
    if (!seen && checkChain) {
      try {
        await this.backfill(50, 3);
      } catch (err) {
        this.log(`[chain] could not check the chain for an earlier reveal: ${err instanceof Error ? err.message : String(err)}`);
      }
      seen = find();
    }
    if (!seen) return false;
    row.state = 'revealed';
    delete row.revealing;
    row.reveal = { signature: seen.signature, slot: 0, revealedAt: new Date(seen.revealedAt * 1000).toISOString(), outcome: seen.outcome, edge: seen.edge };
    this.store.save();
    this.changed('calls');
    return true;
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
    if (this.irrelevantTransactions.has(signature)) return 'ignored';

    const tx = await this.fetchTx(signature, via);
    // A missing result can be a temporarily unconfirmed transaction: always retry it later.
    if (!tx) return 'ignored';
    const memo = parseMemo(tx.memo);
    if (!this.authorities.has(tx.signer) || !memo) {
      // A confirmed transaction's signer and memo cannot change. Cache only these definite
      // negatives, not missing transactions or reveals whose commit has yet to arrive.
      this.irrelevantTransactions.add(signature);
      if (this.irrelevantTransactions.size > 1024) {
        const oldest = this.irrelevantTransactions.values().next().value;
        if (oldest !== undefined) this.irrelevantTransactions.delete(oldest);
      }
      return 'ignored';
    }

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
      signer: tx.signer,
      verified: reason === undefined,
      ...(reason ? { reason } : {}),
    };
    this.store.save();
    if (!reason) this.changed('leaderboard');
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
    this.recoverPending();
    return { scanned: all.length, added };
  }

  // ------------------------------------------------------------------ reads

  listCalls(user: string): CallView[] {
    return this.store.data.calls
      .filter((c) => c.user === user && c.state !== 'pending')
      .map((c) => this.view(c))
      .reverse();
  }

  /**
   * A revealed call as the world may see it: the plaintext the player chose to publish, never the salt and never an
   * account. Only verified reveals are served, so this page cannot show a call the chain does not back.
   */
  publicReveal(signature: string) {
    const r = this.store.data.reveals[signature];
    if (!r || !r.verified) throw new ServiceError(404, 'unknown_reveal', 'No such revealed call.');
    return {
      signature: r.signature,
      commitSignature: r.commitSignature,
      handle: r.handle,
      event: r.event,
      condition: r.condition,
      target: r.target,
      entryPrice: r.entryPrice,
      fairPrice: r.fairPrice,
      outcome: r.outcome,
      edge: r.edge,
      revealedAt: new Date(r.revealedAt * 1000).toISOString(),
      network: this.chain.network,
      // The key that actually signed THIS reveal: with several trusted authorities it is not always ours.
      authority: r.signer ?? this.chain.authority,
      /** The on-chain program that checks each record, or null when records are Memos only. */
      program: this.chain.program ?? null,
    };
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
    return { asOf: this.now().toISOString(), minCalls: this.minCalls, network: this.chain.network, source: streamed ? ('quicknode-stream' as const) : ('rpc' as const), rows };
  }

  /** Re-reads a call's commit and reveal from the chain and recomputes the hash. For the verify page and for judges. */
  async verifyCall(id: string, user: string) {
    const row = this.store.data.calls.find((c) => c.id === id && c.user === user && c.state !== 'pending');
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
      program: this.chain.program ?? null,
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
