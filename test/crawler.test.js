import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureServer } from './fixture-site.js';
import { Crawler } from '../src/crawler/Crawler.js';
import { createHttpClient } from '../src/crawler/http.js';
import { config } from '../src/config.js';

let server;
let base;
let http;

before(async () => {
  server = createFixtureServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
  http = createHttpClient({ userAgent: 'LinkLantern-test/1.0', allowPrivateNetworks: true });
});
after(() => { server.close(); http.close(); });

const crawlerConfig = { ...config.crawler, minHostIntervalMs: 0, perHostConcurrency: 4 };

async function scan(opts = {}) {
  const c = new Crawler({ startUrl: `${base}/`, http, crawlerConfig, timeoutMs: 2500, maxLinks: 500, maxPages: 100, ...opts });
  await c.run();
  return { c, links: new Map(c.results().map((l) => [l.url.replace(base, ''), l])) };
}

test('whole-site scan classifies every kind of link correctly', async () => {
  const { c, links } = await scan({ maxDepth: 3 });
  const get = (p) => { const l = links.get(p); assert.ok(l, `expected ${p} in results`); return l; };

  assert.equal(c.fatal, null);
  assert.equal(get('/missing').status, 404);
  assert.equal(get('/missing').result, 'broken');
  assert.equal(get('/missing').occurrenceCount, 2, 'occurrences from two pages');
  assert.equal(get('/gone').status, 410);
  assert.equal(get('/error').status, 500);
  assert.equal(get('/slow').error, 'TIMEOUT');
  assert.equal(get('/loop-a').error, 'REDIRECT_LOOP');
  assert.equal(get('/old').result, 'redirect');
  assert.equal(get('/old').redirects[0].status, 301);
  assert.equal(get('/chain').redirects.length, 2, 'two-hop chain recorded');
  assert.equal(get('/private/secret.html').error, 'ROBOTS');
  assert.equal(get('/private/secret.html').result, 'skipped');
  assert.equal(get('/private/ok.html').result, 'ok', 'Allow overrides Disallow (longest match)');
  assert.equal(get('/head-405').result, 'ok', 'falls back to GET when HEAD is refused');
  assert.equal(get('/rate').result, 'ok', '429 is retried after Retry-After');
  assert.equal(get('/cookie-redirect').result, 'redirect', 'cookie jar prevents false loop');
  assert.equal(get('/img/missing.png').status, 404);
  assert.equal(get('/img/missing-2x.png').status, 404, 'srcset parsed');
  assert.equal(get('/img/inline-missing.png').status, 404, 'inline style url() parsed');
  assert.equal(get('/img/bg-missing.png').status, 404, 'external stylesheet url() parsed');
  assert.equal(get('/page?x=2').status, 404, 'query strings are distinct URLs');
  assert.equal(get('/page?x=1').result, 'ok');
  assert.equal(get('/search').result, 'ok', 'GET form action checked');
  assert.equal(get('/sub/child').result, 'ok', 'crawled through image link');

  const bad = [...links.values()].find((l) => l.error === 'INVALID_URL');
  assert.ok(bad, 'backslash URL flagged');
  const dns = [...links.values()].find((l) => l.url.includes('does-not-exist.invalid'));
  assert.equal(dns.result, 'broken');
  assert.equal(dns.internal, false);

  assert.ok(!links.has('/only-from-nofollow'), 'nofollow link not explored');
  assert.ok(!links.has('/post-only'), 'POST forms are not probed');
  assert.ok(![...links.keys()].some((k) => k.startsWith('mailto:') || k.includes('#')), 'mailto and fragments skipped');
  // depth 3: /deep/3 is opened, the /deep/4 it links to is checked but not opened
  assert.equal(get('/deep/3').isPage, true);
  assert.equal(get('/deep/4').isPage, false, 'page beyond depth limit is checked, not crawled');
  assert.ok(!links.has('/deep/5'), 'depth limit respected');
  assert.equal(get('/about').occurrenceCount, 2, 'page reached via redirects is parsed only once');
});

test('override nofollow explores nofollow links', async () => {
  const { links } = await scan({ maxDepth: 2, overrideNofollow: true });
  assert.ok(links.has('/only-from-nofollow'));
});

test('single page mode checks links but does not crawl', async () => {
  const { c, links } = await scan({ mode: 'page' });
  assert.equal(c.stats.pagesScanned, 1);
  assert.ok(links.has('/about'));
  assert.ok(!links.has('/page?x=1'), 'links on /about were not collected');
});

test('link limit stops collecting new URLs', async () => {
  const { c } = await scan({ maxLinks: 5 });
  assert.equal(c.results().length, 5);
  assert.equal(c.stats.limitReached, true);
});

test('ignore list skips matching URLs', async () => {
  const { links, c } = await scan({ maxDepth: 1, ignore: ['/loop', 'x=2'] });
  assert.ok(!links.has('/loop-a'));
  assert.ok(c.stats.ignored >= 1);
});

test('unreachable start page is a fatal error', async () => {
  const c = new Crawler({ startUrl: `${base}/missing`, http, crawlerConfig, timeoutMs: 2000 });
  await c.run();
  assert.match(c.fatal, /404/);
});

test('private addresses are refused unless allowed', async () => {
  const strict = createHttpClient({ userAgent: 'x', allowPrivateNetworks: false });
  const r1 = await strict.request(`${base}/`);
  assert.equal(r1.error, 'BLOCKED');
  const r2 = await strict.request(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(r2.error, 'BLOCKED');
  strict.close();
});

test('stop() ends a scan promptly', async () => {
  const c = new Crawler({ startUrl: `${base}/`, http, crawlerConfig, timeoutMs: 15000 });
  const p = c.run();
  setTimeout(() => c.stop(), 300);
  const t0 = Date.now();
  await p;
  assert.equal(c.state, 'stopped');
  assert.ok(Date.now() - t0 < 5000);
});
