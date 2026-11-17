// Append-only receipt store: deduplicated in memory, optionally persisted as
// JSONL so the feed survives restarts and QuickNode redeliveries are no-ops.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

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
}

export class ReceiptStore extends EventEmitter<{ receipt: [Receipt] }> {
  private readonly byId = new Map<string, Receipt>();
  private readonly file: string | undefined;

  constructor(file?: string) {
    super();
    this.file = file;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as Receipt;
        this.byId.set(r.id, r);
      }
    }
  }

  /** Returns false when the receipt was already stored. */
  add(r: Receipt): boolean {
    if (this.byId.has(r.id)) return false;
    this.byId.set(r.id, r);
    if (this.file) appendFileSync(this.file, JSON.stringify(r) + '\n');
    this.emit('receipt', r);
    return true;
  }

  /** Receipts in chain order (slot, then position within the transaction). */
  all(): Receipt[] {
    return [...this.byId.values()].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.byId.size;
  }
}
