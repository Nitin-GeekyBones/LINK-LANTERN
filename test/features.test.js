import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { createFixtureServer } from './fixture-site.js';
import { Crawler } from '../src/crawler/Crawler.js';
import { createHttpClient } from '../src/crawler/http.js';
import { detectRecaptcha, normalizeChecklist, compileChecklist, findMatches } from '../src/crawler/detect.js';
import { validateWebhookUrl, buildSlackMessage } from '../src/slack.js';
import { captchaToCsv, matchesToCsv } from '../src/reportFormat.js';
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
const detect = (html) => detectRecaptcha(cheerio.load(html));

test('reCAPTCHA variants are detected and plain pages are not', () => {
  assert.equal(detect('<p>hello</p><script src="/app.js"></script>'), null);
  const v2 = detect('<script src="https://www.google.com/recaptcha/api.js"></script><div class="g-recaptcha" data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></div>');
  assert.equal(v2.variant, 'v2 checkbox');
  assert.equal(v2.siteKey, '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI');
  assert.deepEqual(v2.evidence.sort(), ['script', 'widget']);
  assert.equal(detect('<div class="g-recaptcha" data-size="invisible" data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></div>').variant, 'v2 invisible');
  assert.equal(detect('<script src="https://www.recaptcha.net/recaptcha/api.js?render=6LdCrawlerTestSiteKeyAbcdefghijklmno"></script>').variant, 'v3');
  assert.equal(detect('<script src="https://www.google.com/recaptcha/enterprise.js?render=6LdCrawlerTestSiteKeyAbcdefghijklmno"></script>').variant, 'Enterprise');
  assert.equal(detect('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>').variant, 'v2 checkbox');
});

test('checklist validation rejects oversize input and ignores unknown presets', () => {
  assert.equal(normalizeChecklist(null), null);
  assert.equal(normalizeChecklist({ presets: ['nope'], terms: '  \n ' }), null);
  assert.deepEqual(normalizeChecklist({ presets: ['email', 'email', 'x'], terms: 'a\nb\na' }), { presets: ['email'], terms: ['a', 'b'], caseSensitive: false, wholeWord: false });
  assert.throws(() => normalizeChecklist({ terms: Array.from({ length: 21 }, (_, i) => `t${i}`) }), /up to 20/);
  assert.throws(() => normalizeChecklist({ terms: ['x'.repeat(101)] }), /100 characters/);
});

test('custom terms are literal text, with case and whole-word options', () => {
  const run = (cl, text) => findMatches(text, compileChecklist(normalizeChecklist(cl))).map((m) => m.match);
  assert.deepEqual(run({ terms: 'a.c (x)' }, 'abc a.c (x) A.C (X)'), ['a.c (x)', 'A.C (X)']);
  assert.deepEqual(run({ terms: 'a.c (x)', caseSensitive: true }, 'A.C (X) a.c (x)'), ['a.c (x)']);
  assert.deepEqual(run({ terms: 'cat', wholeWord: true }, 'concatenate, cat. Cat'), ['cat', 'Cat']);
});

test('phone preset skips dates and order numbers', () => {
  const found = findMatches('Call +44 20 7946 0958 or (415) 555-0132. Date 2024-05-01, order 12345, v1.2.3', compileChecklist({ presets: ['phone'], terms: [] }));
  assert.deepEqual(found.map((m) => m.match), ['+44 20 7946 0958', '(415) 555-0132']);
});

test('crawler records CAPTCHA pages and checklist matches', async () => {
  const c = new Crawler({
    startUrl: `${base}/contact`, mode: 'page', http, crawlerConfig, timeoutMs: 2500,
    checklist: normalizeChecklist({ presets: ['email', 'phone', 'price', 'placeholder', 'copyright'], terms: 'Old Brand Name' }),
  });
  await c.run();
  const { captcha, matches } = c.findings();
  assert.equal(captcha.length, 1);
  assert.equal(captcha[0].page, `${base}/contact`);
  assert.equal(captcha[0].variant, 'v2 checkbox');
  const byRule = (r) => matches.filter((m) => m.rule === r).map((m) => m.match);
  assert.deepEqual(byRule('email'), ['hello@fixture.example', 'sales@fixture.example']);
  assert.deepEqual(byRule('phone'), ['+1 (415) 555-0132']);
  assert.deepEqual(byRule('price'), ['$1,299.00']);
  assert.ok(byRule('placeholder').includes('Lorem ipsum'));
  assert.deepEqual(byRule('copyright'), ['© 2019']);
  assert.deepEqual(byRule('term'), ['Old Brand Name'], 'link text counts, one entry per distinct match');
  assert.equal(c.stats.captchaPages, 1);
  assert.equal(c.stats.textMatches, matches.length);
  assert.match(matches.find((m) => m.rule === 'email').snippet, /write to hello@fixture\.example/);
  assert.equal(matches.find((m) => m.match === 'sales@fixture.example').snippet, 'Link to sales@fixture.example');
});

test('pages without CAPTCHA are not listed, and no checklist means no matches', async () => {
  const plain = new Crawler({ startUrl: `${base}/about`, mode: 'page', http, crawlerConfig, timeoutMs: 2500 });
  await plain.run();
  assert.deepEqual(plain.findings(), { captcha: [], matches: [] });
  const v3 = new Crawler({ startUrl: `${base}/signup-v3`, mode: 'page', http, crawlerConfig, timeoutMs: 2500 });
  await v3.run();
  assert.equal(v3.findings().captcha[0].variant, 'v3');
});

test('Slack webhook URLs are restricted to Slack', () => {
  assert.equal(validateWebhookUrl(' https://hooks.slack.com/services/T0/B0/abc '), 'https://hooks.slack.com/services/T0/B0/abc');
  for (const bad of ['http://hooks.slack.com/services/T0/B0/abc', 'https://hooks.slack.com.evil.example/services/x', 'https://127.0.0.1/services/x',
    'https://hooks.slack.com:8443/services/T0/B0/abc', 'https://user@hooks.slack.com/services/T0', 'https://hooks.slack.com/api/x', 'not a url']) {
    assert.throws(() => validateWebhookUrl(bad), /Slack/, bad);
  }
});

test('Slack message lists broken links and escapes Slack markup', () => {
  const report = {
    id: 'r1', startUrl: 'https://example.com/', state: 'done', fatal: null,
    stats: { pagesScanned: 3, linksChecked: 40, broken: 12, redirected: 1, captchaPages: 1, textMatches: 4 },
    links: Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/a<b>|${i}`, result: 'broken', status: 404, occurrences: [{ page: 'https://example.com/' }] })),
  };
  const msg = buildSlackMessage([report], 'https://ll.example');
  assert.match(msg.text, /12 broken links on example\.com/);
  const body = JSON.stringify(msg.blocks);
  assert.match(body, /1 page with reCAPTCHA/);
  assert.match(body, /4 checklist matches/);
  assert.match(body, /a&lt;b&gt;%7C0/);
  assert.match(body, /and 2 more/);
  assert.ok(msg.blocks.length <= 50);
});

test('CAPTCHA and match CSV exports', () => {
  const r = {
    captcha: [{ page: 'https://e.com/c', title: 'Contact', type: 'recaptcha', variant: 'v3', siteKey: 'k', evidence: ['script', 'inline-script'] }],
    matches: [{ page: 'https://e.com/c', ruleLabel: 'Email addresses', match: '=cmd@e.com', snippet: 'mail =cmd@e.com, now' }],
  };
  assert.match(captchaToCsv(r), /page,page_title,captcha,variant,site_key,evidence\r\nhttps:\/\/e\.com\/c,Contact,Google reCAPTCHA,v3,k,script inline-script/);
  assert.match(matchesToCsv(r), /Email addresses,'=cmd@e\.com,"mail =cmd@e\.com, now"/);
});
