// Pulls one program's emitted event payloads out of Solana transaction logs.
// Anchor's emit! writes `Program data: <base64>`; the invoke stack tells us
// which program wrote it, so events from other programs in the same
// transaction (including CPI callers and callees) are not misattributed.

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

export function extractProgramData(logs: readonly string[], programId: string): Buffer[] {
  const stack: string[] = [];
  const out: Buffer[] = [];
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.length = Number(inv[2]) - 1;
      stack.push(inv[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith(DATA) && stack[stack.length - 1] === programId) {
      out.push(Buffer.from(line.slice(DATA.length).trim(), 'base64'));
    }
  }
  return out;
}

export interface StreamTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  logs: string[];
}

/**
 * Finds transactions in a Streams delivery. The Programs + Logs dataset nests
 * them as data[][]; a filter function may reshape that, so walk instead of
 * assuming a depth. Failed transactions are skipped.
 */
export function collectTxs(payload: unknown): StreamTx[] {
  const out: StreamTx[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    if (typeof o.signature === 'string' && Array.isArray(o.logs)) {
      if (o.success === false) return;
      out.push({
        signature: o.signature,
        slot: typeof o.slot === 'number' ? o.slot : 0,
        blockTime: typeof o.blockTime === 'number' ? o.blockTime : null,
        logs: o.logs.filter((l): l is string => typeof l === 'string'),
      });
      return;
    }
    for (const value of Object.values(o)) walk(value, depth + 1);
  };
  walk(payload, 0);
  return out;
}
