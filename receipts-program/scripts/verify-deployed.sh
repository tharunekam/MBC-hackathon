#!/usr/bin/env bash
# Is the program on Solana the one in this folder?
#
#   scripts/verify-deployed.sh [rpc-url]        (default: public devnet)
#
# Downloads the deployed program and compares it, byte for byte, with target/deploy/given_receipts.so. Build first with
# `anchor build`. Reads only; needs the Solana CLI. Exit code 0 only when the two are identical.
#
# What a match proves: the deployed program is exactly the file this checkout builds on this machine. It is not a
# Docker-reproducible ("verified") build, so a different machine or toolchain may produce different bytes from the same
# source; the README lists the toolchain the deployed build was made with.
set -euo pipefail

PROGRAM_ID=8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK
RPC_URL="${1:-https://api.devnet.solana.com}"
here="$(cd "$(dirname "$0")/.." && pwd)"
built="$here/target/deploy/given_receipts.so"

if [ ! -f "$built" ]; then
  echo "No build found at $built. Run: anchor build" >&2
  exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/given-verify.XXXXXX")"
trap 'rm -f "$work/deployed.so"; rmdir "$work"' EXIT

solana program dump "$PROGRAM_ID" "$work/deployed.so" --url "$RPC_URL" >/dev/null

sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
deployed="$(sum "$work/deployed.so")"
local_build="$(sum "$built")"

echo "program   $PROGRAM_ID"
echo "deployed  $deployed  ($(wc -c <"$work/deployed.so" | tr -d ' ') bytes)"
echo "built     $local_build  ($(wc -c <"$built" | tr -d ' ') bytes)"
solana program show "$PROGRAM_ID" --url "$RPC_URL" | grep -E "Authority|Last Deployed" || true

if [ "$deployed" = "$local_build" ]; then
  echo "MATCH: the deployed program is this build."
else
  echo "DIFFERENT: the deployed program is not this build." >&2
  exit 1
fi
