// QuickNode Streams filter for Given.
//
// Stream: Solana DEVNET, dataset "Programs + Logs".
// Paste this into the Stream's filter editor (the function must be named `main`).
//
// It keeps the Stream quiet: of every batch of blocks, only successful transactions that logged a Given memo are
// delivered, and only as { sig, slot }. That is all the chain service needs. It re-reads each signature from Solana
// itself, checks the signer is our authority and verifies the record, so nothing in this payload is trusted.
//
// QuickNode runs this once per batch: `stream.data` holds one array of transactions for each block in the batch, each
// transaction as { signature, slot, blockTime, success, logs[], programInvocations[] }. Returning null delivers nothing.
// Those names were checked against QuickNode's Streams documentation on 2026-11-18, and the tests run this file on the
// log lines of real devnet records. It has NOT yet run on a live Stream. To run it on QuickNode against a real block
// without creating a Stream:  npm run quicknode -- test-filter   (or "Run test" in the Stream's filter editor).
// The server side does not depend on this shape.

function flatten(v, out, depth) {
  if (depth > 5 || v === null || v === undefined) return;
  if (Array.isArray(v)) {
    for (const x of v) flatten(x, out, depth + 1);
  } else if (typeof v === 'object') {
    if (typeof v.signature === 'string') out.push(v);
    else for (const k of Object.keys(v)) flatten(v[k], out, depth + 1);
  }
}

function main(stream) {
  const txs = [];
  flatten(stream.data, txs, 0);
  const out = [];
  for (const tx of txs) {
    if (tx.success === false) continue;
    const logs = Array.isArray(tx.logs) ? tx.logs : [];
    // A Memo-program log line looks like:  Program log: Memo (len 118): "{\"g\":1,\"t\":\"c\",...}"
    // (quotes inside the memo may appear escaped or not, so accept both).
    const ours = logs.some((l) => typeof l === 'string' && l.indexOf('Program log: Memo') === 0 && (l.indexOf('{\\"g\\":1,') !== -1 || l.indexOf('{"g":1,') !== -1));
    if (ours) out.push({ sig: tx.signature, slot: tx.slot });
  }
  return out.length > 0 ? out : null; // null: deliver nothing for this batch
}
