// Append-only receipt store: deduplicated in memory, optionally persisted as
// JSONL so the service survives restarts and QuickNode redeliveries are no-ops.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

/** How an event reached this service. */
export type ReceiptSource = 'quicknode-stream' | 'rpc';

export interface Receipt {
  /** `${signature}:${eventIndex}`: unique per emitted event. */
  id: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Raw event bytes (discriminator + borsh), base64. */
  data: string;
  /** Decoded fields; null when the decoder does not recognise the event. */
  decoded: Record<string, unknown> | null;
  source: ReceiptSource;
}

export class ReceiptStore extends EventEmitter<{ receipt: [Receipt] }> {
  private readonly byId = new Map<string, Receipt>();
  private readonly signatures = new Set<string>();
  private readonly file: string | undefined;

  constructor(file?: string) {
    super();
    this.file = file;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as Receipt;
        // A later line for the same id replaces the earlier one (see add()).
        this.byId.set(r.id, { ...r, source: r.source ?? 'quicknode-stream' });
        this.signatures.add(r.signature);
      }
    } else if (file) {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  /**
   * Returns false when the receipt was already stored. An event first read
   * from RPC and later delivered by the Stream is re-marked as stream-fed.
   */
  add(r: Receipt): boolean {
    const known = this.byId.get(r.id);
    if (known) {
      if (known.source === 'rpc' && r.source === 'quicknode-stream') {
        known.source = r.source;
        if (this.file) appendFileSync(this.file, JSON.stringify(known) + '\n');
      }
      return false;
    }
    this.byId.set(r.id, r);
    this.signatures.add(r.signature);
    if (this.file) appendFileSync(this.file, JSON.stringify(r) + '\n');
    this.emit('receipt', r);
    return true;
  }

  hasSignature(signature: string): boolean {
    return this.signatures.has(signature);
  }

  /** Receipts in chain order (slot, then position within the transaction). */
  all(): Receipt[] {
    return [...this.byId.values()].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.byId.size;
  }
}
