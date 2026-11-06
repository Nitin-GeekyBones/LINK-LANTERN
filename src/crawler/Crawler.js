// The scan engine. One Crawler instance == one scan of one website.
//
// Algorithm (breadth-first):
//   1. Fetch the start page. If it fails, the scan ends with a "fatal" message.
//      If it redirects (e.g. example.com -> www.example.com) the final host
//      becomes the site being scanned.
//   2. Every link found is recorded once (keyed by absolute URL without
//      #fragment; different query strings are different URLs) together with
//      every place it occurs.
//   3. Each unique URL is checked once. Same-site HTML pages within the depth
//      limit are fetched with GET and parsed for more links; everything else
//      gets a HEAD request (falling back to GET when HEAD is refused).
//   4. robots.txt of every host is honoured, Crawl-delay slows that host down,
//      429/503 trigger a pause, a retry and an adaptive slow-down.
import { EventEmitter } from 'node:events';
import { resolveLink, extractFromHtml, extractCssUrls } from './extract.js';
import { fetchRobots, Robots } from './robots.js';
import { HostThrottle, sleep } from './throttle.js';
import { statusLabel, describeError } from './statusCodes.js';
import { compileChecklist } from './detect.js';

const MAX_TEXT_MATCHES = 5000;

const RETRYABLE_ERRORS = new Set(['TIMEOUT', 'RESET']);
const HTML_TYPE = /(text\/html|application\/xhtml\+xml)/i;
const CSS_TYPE = /text\/css/i;

function parseRetryAfter(v, cap) {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(n * 1000, cap);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.min(Math.max(d - Date.now(), 0), cap) : null;
}

export function normalizeStartUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Please enter a website address.');
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hadScheme) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That does not look like a valid web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http:// and https:// addresses can be checked.');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost' && !/^\[.*\]$/.test(u.hostname)) {
    throw new Error('Please enter a full domain name, such as example.com.');
  }
  u.hash = '';
  return { url: u.href, hadScheme };
}

export class Crawler extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.startUrl
   * @param {'site'|'page'} o.mode         whole site or a single page
   * @param {number} o.maxDepth            link depth to crawl (start page = 0)
   * @param {number} o.maxLinks            unique URLs to check
   * @param {number} o.maxPages            pages to download and parse
   * @param {string[]} o.ignore            skip URLs containing any of these strings
   * @param {number} o.timeoutMs
   * @param {number} o.intervalMs          minimum gap between requests to the scanned site
   * @param {boolean} o.overrideNofollow   crawl through rel=nofollow / meta nofollow
   * @param {boolean} o.restrictToDir      only crawl pages under the start URL's directory
   * @param {object} [o.checklist]         normalized content checklist (see detect.js)
   * @param {object} o.http                client from createHttpClient()
   * @param {object} o.crawlerConfig       config.crawler
   */
  constructor(o) {
    super();
    const c = o.crawlerConfig;
    this.c = c;
    this.http = o.http;
    const { url, hadScheme } = normalizeStartUrl(o.startUrl);
    this.startUrl = url;
    this.hadScheme = hadScheme;
    this.mode = o.mode === 'page' ? 'page' : 'site';
    this.maxDepth = this.mode === 'page' ? 0 : Math.min(Math.max(o.maxDepth ?? c.defaultDepth, 0), c.maxDepth);
    this.maxLinks = Math.max(1, o.maxLinks ?? 2000);
    this.maxPages = Math.max(1, o.maxPages ?? 500);
    this.ignore = (o.ignore || []).map((s) => String(s).trim()).filter(Boolean);
    this.timeoutMs = Math.min(Math.max(o.timeoutMs || c.timeoutMs, 2000), c.maxTimeoutMs);
    this.intervalMs = Math.max(o.intervalMs || 0, 0);
    this.overrideNofollow = !!o.overrideNofollow;
    this.restrictToDir = !!o.restrictToDir;
    this.checklist = o.checklist || null;
    this.rules = compileChecklist(this.checklist);

    this._setSite(this.startUrl);

    this.links = new Map();       // url -> record
    this.parsedPages = new Set(); // final URLs already parsed (several links may redirect to one page)
    this.ignored = new Set();
    this.captchaPages = [];       // only pages where a CAPTCHA was found
    this.textMatches = [];
    this.queue = [];
    this.waiters = [];
    this.inFlight = 0;
    this.pagesReserved = 0;
    this.stopped = false;
    this.abort = new AbortController();
    this.throttle = new HostThrottle({ perHost: c.perHostConcurrency, minIntervalMs: c.minHostIntervalMs, maxIntervalMs: c.maxCrawlDelayMs });
    this.robots = new Map();      // origin -> Promise<Robots>
    this.fatal = null;
    this.state = 'idle';
    this.stats = {
      pagesScanned: 0, linksFound: 0, linksChecked: 0, ok: 0, broken: 0, redirected: 0,
      skipped: 0, ignored: 0, captchaPages: 0, textMatches: 0, limitReached: false, pageLimitReached: false, matchLimitReached: false,
      startedAt: null, finishedAt: null, currentUrl: '',
    };
    this._lastProgress = 0;
  }

  _setSite(url) {
    const u = new URL(url);
    this.siteHost = u.hostname.toLowerCase();
    const dir = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/[^/]*$/, '');
    this.scopePath = dir || '/';
  }

  isInternal(u) { return u.hostname.toLowerCase() === this.siteHost; }
  inScope(u) { return this.isInternal(u) && (!this.restrictToDir || u.pathname.startsWith(this.scopePath)); }
  isIgnored(url) { return this.ignore.some((s) => url.includes(s)); }

  // ---------------------------------------------------------------- public
  async run() {
    this.state = 'running';
    this.stats.startedAt = new Date().toISOString();
    this.emitProgress(true);

    let start = this._newRecord(this.startUrl, 0);
    start.isStart = true;
    await this._process({ rec: start, depth: 0, crawl: true });

    // Bare domain typed and https failed at the connection level -> try http://
    if (!this.hadScheme && start.error && ['REFUSED', 'TLS', 'TIMEOUT', 'RESET', 'NETWORK'].includes(start.error) && !this.stopped) {
      const httpUrl = this.startUrl.replace(/^https:/, 'http:');
      this.links.clear();
      this._resetCounters();
      this.startUrl = httpUrl;
      this._setSite(httpUrl);
      start = this._newRecord(httpUrl, 0);
      start.isStart = true;
      await this._process({ rec: start, depth: 0, crawl: true });
    }

    if (!this.fatal) {
      if (start.error === 'ROBOTS') this.fatal = `The site's robots.txt does not allow ${this.c.userAgentToken} to fetch ${this.startUrl}.`;
      else if (start.result === 'broken') this.fatal = `The starting page could not be loaded: ${start.label}.`;
      else if (start.result !== 'skipped' && !start.isPage) {
        this.fatal = start.contentType
          ? `The starting URL is not an HTML page (${start.contentType.split(';')[0]}), so there are no links to check.`
          : 'The starting URL did not return an HTML page, so there are no links to check.';
      }
    }

    if (!this.fatal && !this.stopped) {
      const workers = Array.from({ length: this.c.concurrency }, () => this._worker());
      await Promise.all(workers);
    }

    // anything left in the queue was never checked
    for (const rec of this.links.values()) {
      if (rec.result === 'pending') {
        rec.result = 'skipped'; rec.error = 'STOPPED'; rec.label = describeError('STOPPED');
        this.stats.skipped++;
      }
    }
    this.state = this.stopped ? 'stopped' : 'done';
    this.stats.finishedAt = new Date().toISOString();
    this.stats.currentUrl = '';
    this.emitProgress(true);
    this.emit('done', this.snapshot());
    return this.snapshot();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.throttle.releaseAll();
    this._wake();
  }

  snapshot() {
    return { state: this.state, fatal: this.fatal, startUrl: this.startUrl, stats: { ...this.stats, queued: this.queue.length, inFlight: this.inFlight } };
  }

  /** All link records, serialisable. */
  results() {
    return [...this.links.values()].map((r) => ({
      url: r.url, result: r.result, status: r.status, label: r.label, error: r.error,
      redirects: r.redirects, finalUrl: r.finalUrl, contentType: r.contentType,
      internal: r.internal, isPage: r.isPage, depth: r.depth, timeMs: r.timeMs,
      occurrences: r.occurrences, occurrenceCount: r.occurrenceCount, isStart: !!r.isStart,
    }));
  }

  /** Page-level findings, serialisable. */
  findings() {
    return { captcha: this.captchaPages.slice(), matches: this.textMatches.slice() };
  }

  // --------------------------------------------------------------- internal
  _resetCounters() {
    Object.assign(this.stats, { pagesScanned: 0, linksFound: 0, linksChecked: 0, ok: 0, broken: 0, redirected: 0, skipped: 0, captchaPages: 0, textMatches: 0 });
    this.pagesReserved = 0;
    this.captchaPages = [];
    this.textMatches = [];
  }

  _recordFindings(page, title, captcha, matches) {
    if (captcha) {
      const rec = { page, title, ...captcha };
      this.captchaPages.push(rec);
      this.stats.captchaPages = this.captchaPages.length;
      this.emit('captcha', rec);
    }
    if (matches.length) {
      const room = MAX_TEXT_MATCHES - this.textMatches.length;
      if (room < matches.length) this.stats.matchLimitReached = true;
      const add = matches.slice(0, Math.max(room, 0)).map((m) => ({ page, ...m }));
      if (!add.length) return;
      this.textMatches.push(...add);
      this.stats.textMatches = this.textMatches.length;
      this.emit('matches', add);
    }
  }

  _newRecord(url, depth, invalid = false) {
    let internal = false;
    try { internal = this.isInternal(new URL(url)); } catch { /* invalid */ }
    const rec = {
      url, depth, internal, invalid, result: 'pending', status: null, label: '', error: null,
      redirects: [], finalUrl: null, contentType: null, timeMs: null, isPage: false,
      occurrences: [], occurrenceCount: 0, task: null,
    };
    this.links.set(url, rec);
    this.stats.linksFound = this.links.size;
    return rec;
  }

  _discover(link, pageUrl, base, depth, pageNofollow) {
    const res = resolveLink(link.raw, base);
    if (!res) return;
    const key = res.url;
    if (!res.invalid && this.isIgnored(key)) {
      this.ignored.add(key);
      this.stats.ignored = this.ignored.size;
      return;
    }
    const occ = { page: pageUrl, text: link.text, tag: link.tag, attr: link.attr };
    let rec = this.links.get(key);
    let u = null;
    if (!res.invalid) { try { u = new URL(key); } catch { /* unreachable */ } }
    const follow = this.overrideNofollow || (!link.nofollow && !pageNofollow);
    const crawl = !!u && link.navigable && this.inScope(u) && depth <= this.maxDepth && follow;

    if (rec) {
      rec.occurrenceCount++;
      if (rec.occurrences.length < this.c.maxOccurrencesPerLink) rec.occurrences.push(occ);
      // upgrade a still-queued plain check to a crawl if this occurrence allows it
      if (crawl && rec.task && rec.result === 'pending' && !rec.task.crawl) { rec.task.crawl = true; rec.task.depth = depth; }
      return;
    }
    if (this.links.size >= this.maxLinks) { this.stats.limitReached = true; return; }
    rec = this._newRecord(key, depth, !!res.invalid);
    rec.occurrenceCount = 1;
    rec.occurrences.push(occ);
    if (res.invalid) rec.invalidReason = res.reason;
    const wantCss = !!u && link.tag === 'link' && this.isInternal(u);
    const task = { rec, depth, crawl, wantCss };
    rec.task = task;
    this.queue.push(task);
    this._wake();
  }

  _wake() { const ws = this.waiters; this.waiters = []; ws.forEach((w) => w()); }

  async _worker() {
    while (!this.stopped) {
      const task = this.queue.shift();
      if (!task) {
        if (this.inFlight === 0) { this._wake(); return; }
        await new Promise((r) => this.waiters.push(r));
        continue;
      }
      this.inFlight++;
      try {
        await this._process(task);
      } catch (err) {
        // never let one bad URL kill the scan
        const rec = task.rec;
        if (rec.result === 'pending') this._finalize(rec, { error: 'NETWORK', errorLabel: `Internal error: ${err.message}`, redirects: [] });
      } finally {
        this.inFlight--;
        this._wake();
      }
    }
    this._wake();
  }

  async _robotsFor(u) {
    const origin = u.origin;
    if (!this.robots.has(origin)) {
      const p = (async () => {
        const release = await this.throttle.acquire(u.host, this.abort.signal);
        try {
          return await fetchRobots(this.http, origin, { agentToken: this.c.userAgentToken, timeoutMs: Math.min(this.timeoutMs, 10000), signal: this.abort.signal });
        } catch {
          return Robots.allowEverything('error');
        } finally { release(); }
      })().then((robots) => {
        if (robots.crawlDelay) this.throttle.setCrawlDelay(u.host, robots.crawlDelay);
        return robots;
      });
      this.robots.set(origin, p);
    }
    return this.robots.get(origin);
  }

  async _fetch(url, opts) {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      const release = await this.throttle.acquire(host, this.abort.signal);
      let r;
      try {
        if (this.stopped) return { error: 'STOPPED', errorLabel: describeError('STOPPED'), redirects: [] };
        r = await this.http.request(url, { ...opts, timeoutMs: this.timeoutMs, signal: this.abort.signal });
      } finally { release(); }
      const throttled = r.status === 429 || r.status === 503;
      const retryable = throttled || RETRYABLE_ERRORS.has(r.error);
      if (!retryable || attempt >= this.c.retries || this.stopped) return r;
      if (throttled) this.throttle.slowDown(host);
      const wait = parseRetryAfter(r.retryAfter, this.c.maxRetryAfterMs) ?? 2000 * (attempt + 1);
      await sleep(wait, this.abort.signal);
    }
  }

  async _process(task) {
    const { rec } = task;
    this.stats.currentUrl = rec.url;
    this.emitProgress();

    if (rec.invalid) {
      return this._finalize(rec, { error: 'INVALID_URL', errorLabel: rec.invalidReason === 'backslash' ? 'Malformed URL (contains a backslash)' : describeError('INVALID_URL'), redirects: [] });
    }
    const u = new URL(rec.url);

    const robots = await this._robotsFor(u);
    if (!robots.isAllowed(u.pathname + u.search)) {
      return this._finalize(rec, { error: 'ROBOTS', errorLabel: describeError('ROBOTS'), redirects: [] });
    }
    if (this.isInternal(u) && this.intervalMs) this.throttle.setInterval(u.host, this.intervalMs);

    let crawl = task.crawl && this.pagesReserved < this.maxPages;
    if (task.crawl && !crawl) this.stats.pageLimitReached = true;
    if (crawl) this.pagesReserved++;
    const wantBody = crawl || task.wantCss;

    let r = await this._fetch(rec.url, { method: wantBody ? 'GET' : 'HEAD', wantBody });
    // Many servers mishandle HEAD: retry with GET before declaring a link broken.
    if (!wantBody && !this.stopped && ((r.status && r.status >= 400) || r.error === 'RESET' || r.error === 'NETWORK')) {
      const g = await this._fetch(rec.url, { method: 'GET', wantBody: false });
      if (!g.error || !r.status) r = g; else if (g.status) r = g;
    }
    this._finalize(rec, r);

    if (r.error || !r.body || r.status < 200 || r.status >= 300) {
      if (crawl) this.pagesReserved--;
      return;
    }

    const finalUrl = r.finalUrl || rec.url;
    // The start page may redirect to a different host (example.com -> www.example.com)
    if (rec.isStart && r.redirects.length) this._setSite(finalUrl);
    const fu = new URL(finalUrl);

    if (CSS_TYPE.test(r.contentType) && task.wantCss) {
      for (const raw of extractCssUrls(r.body)) {
        this._discover({ raw, text: '<css url()>', tag: 'css', attr: 'url()', navigable: false, nofollow: false }, finalUrl, finalUrl, task.depth + 1, false);
      }
      if (crawl) this.pagesReserved--;
      return;
    }

    if (!crawl || !HTML_TYPE.test(r.contentType) || !this.inScope(fu)) {
      if (crawl) this.pagesReserved--;
      return;
    }

    if (this.parsedPages.has(finalUrl)) { this.pagesReserved--; return; }
    this.parsedPages.add(finalUrl);
    rec.isPage = true;
    this.stats.pagesScanned++;
    const { links, base, pageNofollow, title, captcha, matches } = extractFromHtml(r.body, finalUrl, { agentToken: this.c.userAgentToken, rules: this.rules });
    rec.title = title;
    this._recordFindings(finalUrl, title, captcha, matches);
    for (const link of links) this._discover(link, finalUrl, base, task.depth + 1, pageNofollow);
    this.emitProgress();
  }

  _finalize(rec, r) {
    if (rec.result !== 'pending') return;
    rec.status = r.status ?? null;
    rec.error = r.error || null;
    rec.redirects = r.redirects || [];
    rec.finalUrl = r.finalUrl && r.finalUrl !== rec.url ? r.finalUrl : null;
    rec.contentType = r.contentType || null;
    rec.timeMs = r.timeMs ?? null;

    if (r.error === 'ROBOTS' || r.error === 'STOPPED') {
      rec.result = 'skipped';
      rec.label = r.errorLabel;
      this.stats.skipped++;
    } else if (r.error) {
      rec.result = 'broken';
      rec.label = r.errorLabel || describeError(r.error);
      this.stats.broken++;
    } else if (r.status >= 300) {
      rec.result = 'broken';
      rec.label = statusLabel(r.status, r.statusText);
      this.stats.broken++;
    } else if (rec.redirects.length) {
      rec.result = 'redirect';
      rec.label = `${statusLabel(r.status, r.statusText)} (after ${rec.redirects.length} redirect${rec.redirects.length > 1 ? 's' : ''})`;
      this.stats.redirected++;
    } else {
      rec.result = 'ok';
      rec.label = statusLabel(r.status, r.statusText);
      this.stats.ok++;
    }
    if (rec.result !== 'skipped') this.stats.linksChecked++;
    rec.task = null;
    this.emit('link', {
      url: rec.url, result: rec.result, status: rec.status, label: rec.label, error: rec.error,
      redirects: rec.redirects, finalUrl: rec.finalUrl, internal: rec.internal,
      occurrences: rec.occurrences.slice(0, 5), occurrenceCount: rec.occurrenceCount, isStart: !!rec.isStart,
    });
  }

  emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this._lastProgress < 300) return;
    this._lastProgress = now;
    this.emit('progress', this.snapshot());
  }
}
