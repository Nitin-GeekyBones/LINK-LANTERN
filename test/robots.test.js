import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Robots } from '../src/crawler/robots.js';
import { resolveLink, extractFromHtml } from '../src/crawler/extract.js';
import { isPrivateAddress } from '../src/crawler/http.js';
import { reportToCsv } from '../src/reportFormat.js';

test('robots: specific agent group wins over *', () => {
  const r = Robots.parse('User-agent: *\nDisallow: /\n\nUser-agent: LinkLantern\nDisallow: /admin\nCrawl-delay: 2\n', 'linklantern');
  assert.equal(r.isAllowed('/'), true);
  assert.equal(r.isAllowed('/admin/x'), false);
  assert.equal(r.crawlDelay, 2);
});

test('robots: wildcards, $ anchors and longest match', () => {
  const r = Robots.parse('User-agent: *\nDisallow: /*.pdf$\nDisallow: /shop/\nAllow: /shop/public\n', 'linklantern');
  assert.equal(r.isAllowed('/files/a.pdf'), false);
  assert.equal(r.isAllowed('/files/a.pdf?x=1'), true);
  assert.equal(r.isAllowed('/shop/cart'), false);
  assert.equal(r.isAllowed('/shop/public/item'), true);
  assert.equal(r.isAllowed('/robots.txt'), true);
});

test('robots: grouped user-agent lines and empty disallow', () => {
  const r = Robots.parse('User-agent: a\nUser-agent: *\nDisallow:\n', 'linklantern');
  assert.equal(r.isAllowed('/anything'), true);
});

test('resolveLink handles relative, fragments and schemes', () => {
  assert.deepEqual(resolveLink('../b?x=1#frag', 'https://e.com/a/c/'), { url: 'https://e.com/a/b?x=1' });
  assert.equal(resolveLink('#top', 'https://e.com/'), null);
  assert.equal(resolveLink('mailto:a@b.c', 'https://e.com/'), null);
  assert.equal(resolveLink('javascript:void(0)', 'https://e.com/'), null);
  assert.equal(resolveLink('a\\b', 'https://e.com/').invalid, true);
});

test('extract honours <base> and meta robots nofollow', () => {
  const html = '<base href="https://cdn.e.com/x/"><meta name="robots" content="noindex, nofollow"><a href="p">P</a>';
  const out = extractFromHtml(html, 'https://e.com/');
  assert.equal(out.base, 'https://cdn.e.com/x/');
  assert.equal(out.pageNofollow, true);
  assert.equal(out.links[0].text, 'P');
});

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('CSV export escapes and neutralises formulas', () => {
  const csv = reportToCsv({ links: [{ result: 'broken', status: 404, label: '404 Not Found', url: 'https://e.com/a,b', occurrences: [{ page: 'https://e.com/', text: '=HYPERLINK("x")', tag: 'a', attr: 'href' }], occurrenceCount: 1, redirects: [] }] });
  assert.match(csv, /"https:\/\/e\.com\/a,b"/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});
