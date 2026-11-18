// QuickNode Streams filter for Given.
//
// Stream: Solana DEVNET, dataset "Programs + Logs".
// Paste this into the Stream's filter editor (the function must be named `main`).
//
// It keeps the Stream quiet: of every block, only successful transactions that logged a Given memo are delivered,
// and only as { sig, slot }. That is all the chain service needs. It re-reads each signature from Solana itself, checks
// the signer is our authority and verifies the record, so nothing in this payload is trusted.
//
// NOTE: written from QuickNode's documentation of the "Programs + Logs" payload (signature, slot, success, logs[]) and
// NOT yet run against a live Stream. Open the Stream's "test filter" with a recent block to confirm the field names,
// and adjust `flatten`/the field reads below if the payload differs. The server side does not depend on this shape.

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
  return out.length > 0 ? out : null; // null: deliver nothing for this block
}
