import { FakeChain } from '../src/chain.ts';
import type { BetSource, ExecutorBet } from '../src/executor.ts';
import { ChainService } from '../src/service.ts';
import type { ServiceOptions } from '../src/service.ts';
import { Store } from '../src/store.ts';

export class FakeBets implements BetSource {
  readonly bets = new Map<string, ExecutorBet>();
  async assertExecutor(): Promise<void> {}
  async getBet(id: string): Promise<ExecutorBet | null> {
    return this.bets.get(id) ?? null;
  }
  add(over: Partial<ExecutorBet> = {}): ExecutorBet {
    const bet: ExecutorBet = {
      id: `b${this.bets.size + 1}`,
      user: 'primary',
      createdAt: '2026-11-18T01:00:00.000Z',
      eventTicker: 'BTC2611190100',
      eventTitle: 'BTC price today at 8pm EST',
      condition: { symbol: 'GEMI-BTC2611190100-HI62500', label: '$62,500 or above', strike: 62500 },
      target: { symbol: 'GEMI-BTC2611190100-HI63500', label: '$63,500 or above', strike: 63500 },
      status: 'open',
      quotedPrice: 0.4375,
      payoffs: { hedged: true, conditionalPrice: 0.4375 },
      offer: { fairPrice: 0.41 },
      ...over,
    };
    this.bets.set(bet.id, bet);
    return bet;
  }
  settle(id: string, conditionResolved: 'yes' | 'no', targetResolved: 'yes' | 'no'): void {
    const b = this.bets.get(id)!;
    b.status = 'settled';
    b.settlement = { conditionResolved, targetResolved, payout: 0 };
  }
}

export function setup(over: Partial<ServiceOptions> = {}) {
  const chain = new FakeChain();
  const bets = new FakeBets();
  const store = new Store(null, () => 'test-secret');
  let n = 0;
  const service = new ChainService({ chain, store, bets, newId: () => `call${++n}`, now: () => new Date('2026-11-18T01:30:00Z'), sleep: async () => {}, ...over });
  /** A second, empty service on the same chain: what a verifier with no database sees. */
  const fresh = (opts: Partial<ServiceOptions> = {}) => new ChainService({ chain, store: new Store(null, () => 'other'), bets, sleep: async () => {}, ...opts });
  return { chain, bets, store, service, fresh };
}
