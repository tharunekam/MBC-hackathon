import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API, LIST_PATH, activatePath, call, createBody, creditsPerDay, filterResult, givenStreams, masked, pausePath, streamsIn, testFilterBody, trialHours, validStreamId,
} from '../src/quicknode.ts';
import type { Fetch, StreamPlan } from '../src/quicknode.ts';

const ID = '3f2a9c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';
const plan = (over: Partial<StreamPlan> = {}): StreamPlan => ({
  name: 'given-devnet',
  webhookUrl: 'https://given.example.com/chain/hooks/quicknode',
  hookToken: 'hook-token-value',
  securityToken: 's'.repeat(32),
  filterSource: 'function main(stream) { return null; }',
  ...over,
});

/** A stand-in for fetch that records what was sent. */
function recorder(status = 200, body: unknown = {}) {
  const sent: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl: Fetch = async (url, init) => {
    sent.push({ url, ...init });
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { sent, fetchImpl };
}

test('create: every field QuickNode\'s spec requires, for Solana devnet Programs + Logs to our webhook', () => {
  const body = createBody(plan());
  assert.deepEqual(Object.keys(body).sort(), ['dataset', 'dataset_batch_size', 'destination', 'destination_attributes', 'elastic_batch_enabled', 'filter_function', 'name', 'network', 'region', 'status']);
  assert.equal(body.network, 'solana-devnet');
  assert.equal(body.dataset, 'programs_with_logs');
  assert.equal(body.destination, 'webhook');
  assert.equal(Buffer.from(body.filter_function as string, 'base64').toString('utf8'), 'function main(stream) { return null; }');
  const d = body.destination_attributes as Record<string, unknown>;
  assert.deepEqual(Object.keys(d).sort(), ['compression', 'headers', 'max_retry', 'post_timeout_sec', 'retry_interval_sec', 'security_token', 'url']);
  assert.equal(d.url, 'https://given.example.com/chain/hooks/quicknode');
  assert.deepEqual(d.headers, { Authorization: 'Bearer hook-token-value' });
  assert.equal(d.compression, 'none');
});

test('create: a Stream is made paused unless asked otherwise, so it spends nothing by surprise', () => {
  assert.equal(createBody(plan()).status, 'paused');
  assert.equal(createBody(plan({ active: true })).status, 'active');
});

test('create: refuses what QuickNode or our own receiver would reject', () => {
  assert.throws(() => createBody(plan({ webhookUrl: 'http://given.example.com/chain/hooks/quicknode' })), /https/);
  assert.throws(() => createBody(plan({ webhookUrl: 'https://given.example.com/' })), /hooks\/quicknode/);
  assert.throws(() => createBody(plan({ webhookUrl: 'not a url' })), /not a URL/);
  assert.throws(() => createBody(plan({ hookToken: '' })), /GIVEN_HOOK_TOKEN/);
  assert.throws(() => createBody(plan({ securityToken: 'short' })), /32 characters/);
  assert.throws(() => createBody(plan({ batchSize: 1 })), /at least 5/);
  assert.throws(() => createBody(plan({ filterSource: '  ' })), /empty/);
});

test('what is printed never contains a token', () => {
  const text = JSON.stringify(masked(createBody(plan())));
  assert.ok(!text.includes('hook-token-value'));
  assert.ok(!text.includes('s'.repeat(32)));
  assert.match(text, /given\.example\.com/, 'the address is still shown');
});

test('test_filter: the block goes as a string, with the same network, dataset and filter', () => {
  assert.deepEqual(testFilterBody('function main() {}', 523513183), {
    network: 'solana-devnet',
    dataset: 'programs_with_logs',
    filter_function: Buffer.from('function main() {}').toString('base64'),
    block: '523513183',
  });
  assert.throws(() => testFilterBody('x', -1));
  assert.throws(() => testFilterBody('x', 1.5));
});

test('a stream id must be a full id: an empty one would address every stream on the account', () => {
  assert.equal(validStreamId(ID), true);
  for (const bad of ['', ' ', '..', 'abc', `${ID}/`, `${ID}?x=1`, undefined, null, 7]) assert.equal(validStreamId(bad), false, String(bad));
  assert.equal(pausePath(ID), `/streams/${ID}/pause`);
  assert.equal(activatePath(ID), `/streams/${ID}/activate`);
  assert.throws(() => pausePath(''));
  assert.throws(() => activatePath('../'));
});

test('a call goes to QuickNode\'s Streams API with the key in x-api-key', async () => {
  const { sent, fetchImpl } = recorder(201, { id: ID, status: 'paused' });
  const answer = await call(fetchImpl, 'the-key', 'POST', '/streams', { name: 'x' });
  assert.equal(sent[0]!.url, `${API}/streams`);
  assert.equal(sent[0]!.method, 'POST');
  assert.equal(sent[0]!.headers['x-api-key'], 'the-key');
  assert.equal(sent[0]!.headers['content-type'], 'application/json');
  assert.equal(sent[0]!.body, '{"name":"x"}');
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.json, { id: ID, status: 'paused' });

  const get = recorder(200, { data: [] });
  await call(get.fetchImpl, 'the-key', 'GET', LIST_PATH);
  assert.equal(get.sent[0]!.url, `${API}/streams?limit=20&offset=0`);
  assert.equal(get.sent[0]!.body, undefined);
  assert.equal(get.sent[0]!.headers['content-type'], undefined);
});

test('a call without a key, or to anything but a Streams path, is never sent', async () => {
  const { sent, fetchImpl } = recorder();
  await assert.rejects(() => call(fetchImpl, '', 'GET', LIST_PATH), /QUICKNODE_API_KEY/);
  await assert.rejects(() => call(fetchImpl, 'k', 'POST', '/other'), /Streams path/);
  assert.equal(sent.length, 0);
});

test('a refusal comes back with QuickNode\'s own words, JSON or not', async () => {
  const refused = await call(recorder(422, { message: 'dataset_batch_size too small' }).fetchImpl, 'k', 'POST', '/streams', {});
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 422);
  assert.match(refused.text, /dataset_batch_size/);
  const html = await call(recorder(502, '<html>bad gateway</html>').fetchImpl, 'k', 'GET', LIST_PATH);
  assert.equal(html.ok, false);
  assert.equal(html.json, null);
  assert.match(html.text, /bad gateway/);
});

test('listing reads either documented wrapper and picks out the streams that are ours', () => {
  const ours = { id: ID, name: 'given-devnet', status: 'active', network: 'solana-devnet', dataset: 'programs_with_logs' };
  const other = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'eth', status: 'paused', network: 'ethereum-mainnet', dataset: 'block' };
  assert.deepEqual(streamsIn({ data: [ours, other], pageInfo: { total: 2 } }), [ours, other]);
  assert.deepEqual(streamsIn([ours]), [ours]);
  assert.deepEqual(streamsIn({ data: [{ id: '', name: 'no id' }, null, 'x'] }), []);
  assert.deepEqual(streamsIn(null), []);
  assert.deepEqual(givenStreams([ours, other]), [ours]);
});

test('a filter test result is read whether QuickNode returns it as JSON text or as a value', () => {
  assert.deepEqual(filterResult({ logs: [], result: '[{"sig":"abc","slot":5}]' }), [{ sig: 'abc', slot: 5 }]);
  assert.deepEqual(filterResult({ logs: [], result: [{ sig: 'abc' }] }), [{ sig: 'abc' }]);
  assert.equal(filterResult({ logs: [], result: 'null' }), null);
  assert.equal(filterResult({ logs: [] }), null);
  assert.equal(filterResult({ result: 'not json' }), 'not json');
});

test('the credit budget: a running devnet Stream outlasts the free trial by less than a day', () => {
  assert.ok(creditsPerDay() > 10_000_000 && creditsPerDay() < 11_000_000, String(creditsPerDay()));
  assert.ok(trialHours() >= 20 && trialHours() <= 24, String(trialHours()));
});
