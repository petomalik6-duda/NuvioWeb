import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceCache } from './source-cache.mjs';

test('keeps healthy sources and previous data, retries failures without refetching fresh sources', async () => {
  let time = 0;
  const cache = createSourceCache({ ttl: 1000, retryMs: 10, now: () => time, warn: () => {} });
  const sources = [{url:'https://a.example/'},{url:'https://b.example/'}];
  let calls = 0;
  let fail = new Set(['b.example']);
  const loader = async s => { calls++; if (fail.has(new URL(s.url).hostname)) throw new Error('offline'); return s.url; };
  assert.deepEqual(await cache.load(sources, loader), [sources[0].url]);
  assert.equal(cache.ttl(), 10);
  await cache.load(sources, loader);
  assert.equal(calls, 2);
  time = 11; fail.clear();
  assert.equal((await cache.load(sources, loader)).length, 2);
  assert.equal(calls, 3);
  assert.equal(cache.ttl(), 1000);
  time = 2000; fail = new Set(['a.example','b.example']);
  assert.equal((await cache.load(sources, loader)).length, 2);
});

test('cold simultaneous loads share requests, a total cold outage fails and can recover', async () => {
  let time = 0;
  const cache = createSourceCache({ ttl: 1000, retryMs: 10, now: () => time, warn: () => {} });
  const sources = [{url:'https://a.example/'}];
  let calls = 0;
  const bad = async () => { calls++; throw new Error('offline'); };
  const failed = await Promise.allSettled([cache.load(sources, bad), cache.load(sources, bad)]);
  assert.ok(failed.every(r => r.status === 'rejected'));
  assert.equal(calls, 1);
  time = 11;
  assert.deepEqual(await cache.load(sources, async () => 'recovered'), ['recovered']);
});
