import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeExchange } from './fake.ts';

const rungs = (base: number, step: number) => Array.from({ length: 4 }, (_, i) => ({ strike: base + i * step, bid: 0.4, ask: 0.42 }));

describe('a fake exchange that lists more than one asset', () => {
  const make = () => {
    const ex = new FakeExchange('BTC2611201700', rungs(63000, 500), { title: 'BTC price' });
    ex.addEvent('ETH2611201700', rungs(3100, 25), { title: 'ETH price' });
    return ex;
  };

  it('lists every event, each with its own ladder', async () => {
    const events = await make().listEvents();
    assert.deepEqual(events.map((e) => e.ticker), ['BTC2611201700', 'ETH2611201700']);
    assert.equal(events[1]!.contracts.length, 4);
    assert.equal(events[1]!.contracts[0]!.instrumentSymbol, 'GEMI-ETH2611201700-HI3100');
  });

  it('keeps an event it does not list unknown', async () => {
    await assert.rejects(() => make().getEvent('SOL2611201700'), /unknown event/);
  });

  it('fills an order on an added event and pays it out when that event resolves', async () => {
    const ex = make();
    const symbol = 'GEMI-ETH2611201700-HI3100';
    const placed = await ex.placeOrder({ clientOrderId: 'gv-x-a', symbol, side: 'buy', outcome: 'yes', quantity: 10, limitPrice: 0.5, tif: 'IOC' });
    assert.equal(placed.filledQuantity, 10);
    const before = await ex.cash();
    ex.resolveExtra('ETH2611201700', 3100, 'yes', 3120);
    assert.equal(await ex.cash(), before + 10);
    const settled = (await ex.getEvent('ETH2611201700')).contracts[0]!;
    assert.equal(settled.status, 'settled');
    assert.equal(settled.settlementValue, '3120');
  });

  it('opens an added event again for the next round without touching the first', async () => {
    const ex = make();
    ex.resolveExtra('ETH2611201700', 3100, 'no', 3000);
    ex.relistExtra('ETH2611201700', rungs(3100, 25), { expiryDate: '2026-11-20T18:00:00.000Z', title: 'ETH price later' });
    const eth = await ex.getEvent('ETH2611201700');
    assert.equal(eth.contracts[0]!.status, 'active');
    assert.equal(eth.title, 'ETH price later');
    assert.equal((await ex.getEvent('BTC2611201700')).title, 'BTC price');
  });
});
