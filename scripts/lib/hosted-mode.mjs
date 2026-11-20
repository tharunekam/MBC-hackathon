/** Select the hosted stack's chain and whether the executor can place orders. A replay starts no backend, so it only needs to be accepted. */
export function hostedModeSettings(mode, quotesChain = 'fake') {
  if (!['live', 'quotes', 'fake', 'replay'].includes(mode)) throw new Error('Unknown hosted mode.');
  if (!['fake', 'devnet'].includes(quotesChain)) throw new Error('GIVEN_QUOTES_CHAIN must be fake or devnet.');
  const chain = mode === 'live' || (mode === 'quotes' && quotesChain === 'devnet') ? 'devnet' : 'fake';
  const readOnly = mode === 'quotes';
  return { chain, readOnly, indexOnly: readOnly && chain === 'devnet' };
}
