// QuickNode Streams filter for the Solana "Programs + Logs" dataset.
// Keeps only successful transactions that invoke the receipts program
// (directly or via CPI) and strips them down to what the feed needs.
// scripts/create-stream substitutes __PROGRAM_ID__ before upload.
function main(stream) {
  const PROGRAM_ID = '__PROGRAM_ID__';
  const needle = 'Program ' + PROGRAM_ID + ' invoke';
  const txs = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node.signature !== 'string' || !Array.isArray(node.logs)) return;
    if (node.success === false) return;
    if (!node.logs.some((l) => typeof l === 'string' && l.startsWith(needle))) return;
    txs.push({ signature: node.signature, slot: node.slot, blockTime: node.blockTime, logs: node.logs });
  };
  walk(stream.data);
  return txs.length ? { txs: txs } : null;
}
