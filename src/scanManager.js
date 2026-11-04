// Owns every scan: queueing, concurrency limits, live progress streaming
// (Server-Sent Events), persistence of finished reports and email delivery.
import { Crawler } from './crawler/Crawler.js';
import { newId } from './store.js';
import { reportSummaryHtml, reportToCsv } from './reportFormat.js';

export class ScanError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class ScanManager {
  constructor({ store, config, mailer, http }) {
    this.store = store;
    this.config = config;
    this.mailer = mailer;
    this.http = http;
    this.live = new Map();   // id -> { report, crawler, subscribers:Set, ip }
    this.queue = [];         // ids waiting to start
  }

  /** On boot: anything recorded as queued/running was cut off by a restart. */
  markInterrupted() {
    for (const r of this.store.db.reports) {
      if (r.state === 'queued' || r.state === 'running') {
        const full = this.store.loadReport(r.id);
        const rep = full || { ...r, links: [] };
        rep.state = 'interrupted';
        rep.fatal = rep.fatal || 'The scan was interrupted because the server restarted.';
        this.store.saveReport(rep);
      }
    }
  }

  activeFor({ owner, ip }) {
    let n = 0;
    for (const e of this.live.values()) {
      if (e.report.state !== 'queued' && e.report.state !== 'running') continue;
      if (owner ? e.report.owner === owner : (!e.report.owner && e.ip === ip)) n++;
    }
    return n;
  }

  runningCount() {
    let n = 0;
    for (const e of this.live.values()) if (e.report.state === 'running') n++;
    return n;
  }

  /**
   * Create and enqueue a scan. `limits` must already reflect the user's plan.
   * @returns the report meta (no links)
   */
  createScan({ owner = null, ip, type = 'site', url, mode = 'site', limits, options = {}, scheduleId = null, batchId = null, emailWhenDone = false, skipActiveCheck = false }) {
    if (!skipActiveCheck) {
      const max = owner ? this.config.scans.userConcurrent : this.config.scans.guestConcurrent;
      if (this.activeFor({ owner, ip }) >= max) {
        throw new ScanError(owner
          ? `You already have ${max} scans running. Wait for one to finish or stop it first.`
          : 'A scan from your connection is already running. Please wait for it to finish (or stop it) before starting another.', 429);
      }
    }
    const crawler = new Crawler({
      startUrl: url,
      mode,
      maxDepth: options.depth,
      maxLinks: limits.maxLinks,
      maxPages: limits.maxPages,
      ignore: options.ignore,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      overrideNofollow: options.overrideNofollow,
      restrictToDir: options.restrictToDir,
      http: this.http,
      crawlerConfig: this.config.crawler,
    }); // throws on an invalid URL
    const report = {
      id: newId(12), owner, type, mode, startUrl: crawler.startUrl,
      options: { depth: crawler.maxDepth, maxLinks: crawler.maxLinks, maxPages: crawler.maxPages, ignore: crawler.ignore, timeoutMs: crawler.timeoutMs, intervalMs: crawler.intervalMs, overrideNofollow: crawler.overrideNofollow, restrictToDir: crawler.restrictToDir },
      state: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      stats: { ...crawler.stats }, fatal: null, scheduleId, batchId, emailWhenDone: !!emailWhenDone, links: [],
    };
    this.store.upsertReportIndex(report);
    this.live.set(report.id, { report, crawler, subscribers: new Set(), ip });
    this.queue.push(report.id);
    this._pump();
    return this.meta(report);
  }

  meta(report) {
    const { links, ...m } = report; // eslint-disable-line no-unused-vars
    return m;
  }

  _pump() {
    let i = 0;
    while (i < this.queue.length && this.runningCount() < this.config.scans.maxConcurrent) {
      const id = this.queue[i];
      const e = this.live.get(id);
      if (!e) { this.queue.splice(i, 1); continue; }
      // per-account fairness: an account may only have userConcurrent scans *running*
      const ownerRunning = e.report.owner
        ? [...this.live.values()].filter((x) => x.report.owner === e.report.owner && x.report.state === 'running').length
        : 0;
      if (e.report.owner && ownerRunning >= this.config.scans.userConcurrent) { i++; continue; }
      this.queue.splice(i, 1);
      this._start(e);
    }
    // tell queued scans their position
    this.queue.forEach((id, pos) => this._broadcast(id, 'queued', { position: pos + 1 }));
  }

  _start(entry) {
    const { report, crawler } = entry;
    report.state = 'running';
    report.startedAt = new Date().toISOString();
    this.store.upsertReportIndex(report);
    crawler.on('progress', (snap) => {
      report.stats = snap.stats;
      this._broadcast(report.id, 'progress', { state: report.state, stats: snap.stats });
    });
    crawler.on('link', (l) => {
      if (l.result !== 'ok') this._broadcast(report.id, 'link', l);
    });
    crawler.run()
      .then((snap) => this._finish(entry, snap))
      .catch((err) => {
        console.error(`[scan ${report.id}] crashed:`, err);
        this._finish(entry, { state: 'error', fatal: `Internal error: ${err.message}`, stats: crawler.stats });
      });
  }

  _finish(entry, snap) {
    const { report, crawler } = entry;
    report.state = snap.state;
    if (crawler.startUrl) report.startUrl = crawler.startUrl; // may have fallen back to http://
    report.fatal = snap.fatal || report.fatal || null;
    report.stats = { ...snap.stats };
    report.finishedAt = new Date().toISOString();
    report.links = crawler.results();
    this.store.saveReport(report);
    if (report.owner) this.store.addUsage(report.owner, report.stats.linksChecked || 0);
    this._broadcast(report.id, 'done', { state: report.state, fatal: report.fatal, stats: report.stats });
    for (const res of entry.subscribers) { try { res.end(); } catch { /* ignore */ } }
    this.live.delete(report.id);
    this._pump();
    this._afterFinish(report).catch((err) => console.error('[notify] failed:', err));
  }

  stop(id) {
    const e = this.live.get(id);
    if (!e) return false;
    if (e.report.state === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      e.crawler.state = 'stopped';
      e.crawler.stopped = true;
      this._finish(e, { state: 'stopped', fatal: null, stats: e.crawler.stats });
    } else {
      e.crawler.stop();
    }
    return true;
  }

  /** Report meta (+links if requested), live or from disk. */
  getReport(id, { withLinks = false } = {}) {
    const e = this.live.get(id);
    if (e) {
      const meta = this.meta(e.report);
      meta.stats = { ...e.crawler.stats, queued: e.crawler.queue.length, inFlight: e.crawler.inFlight };
      meta.queuePosition = e.report.state === 'queued' ? this.queue.indexOf(id) + 1 : null;
      if (withLinks) meta.links = e.crawler.results();
      return meta;
    }
    const r = this.store.loadReport(id);
    if (!r) return null;
    if (!withLinks) delete r.links;
    return r;
  }

  isLive(id) { return this.live.has(id); }

  listActive(owner) {
    return [...this.live.values()].filter((e) => e.report.owner === owner).map((e) => ({
      ...this.meta(e.report), stats: { ...e.crawler.stats, queued: e.crawler.queue.length },
    }));
  }

  activeForSchedule(scheduleId) {
    for (const e of this.live.values()) if (e.report.scheduleId === scheduleId) return e.report.id;
    return null;
  }

  // ---------- Server-Sent Events ----------
  subscribe(id, res) {
    const e = this.live.get(id);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!e) {
      const r = this.store.loadReport(id);
      send('done', r ? { state: r.state, fatal: r.fatal, stats: r.stats } : { state: 'missing' });
      return res.end();
    }
    send('snapshot', { state: e.report.state, stats: e.crawler.stats, queuePosition: e.report.state === 'queued' ? this.queue.indexOf(id) + 1 : null });
    // replay problems found so far
    for (const l of e.crawler.results()) {
      if (l.result !== 'ok' && l.result !== 'pending') send('link', { ...l, occurrences: l.occurrences.slice(0, 5) });
    }
    e.subscribers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => { clearInterval(ping); e.subscribers.delete(res); });
  }

  _broadcast(id, event, data) {
    const e = this.live.get(id);
    if (!e) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of e.subscribers) { try { res.write(msg); } catch { /* client gone */ } }
  }

  // ---------- notifications ----------
  async _afterFinish(report) {
    const base = this.config.baseUrl;
    const owner = report.owner ? this.store.getUser(report.owner) : null;
    if (!owner) return;

    if (report.type === 'auto' && report.scheduleId) {
      const sched = this.store.getSchedule(report.scheduleId);
      if (sched) {
        const pinScheme = !/^https?:\/\//i.test(sched.url) && !report.fatal && report.state === 'done';
        this.store.updateSchedule(sched.id, {
          ...(pinScheme ? { url: report.startUrl } : {}),
          lastReportId: report.id, lastRunAt: report.finishedAt,
          lastSummary: { broken: report.stats.broken || 0, checked: report.stats.linksChecked || 0, state: report.state, fatal: report.fatal },
        });
        const quiet = sched.suppressEmptyEmail && !report.fatal && !report.stats.broken;
        if (!quiet && report.state !== 'stopped') {
          await this.mailer.send({
            to: owner.email,
            subject: `Auto check: ${report.stats.broken || 0} broken link(s) on ${new URL(report.startUrl).hostname}`,
            html: reportSummaryHtml(report, base),
            attachments: [{ filename: `linklantern-${report.id}.csv`, content: reportToCsv(report, { only: 'problems' }) }],
          });
        }
      }
      return;
    }

    if (report.type === 'multi' && report.batchId) {
      const batch = this.store.getBatch(report.batchId);
      if (!batch) return;
      const metas = batch.reportIds.map((id) => this.store.getReportMeta(id)).filter(Boolean);
      const allDone = metas.length === batch.reportIds.length && metas.every((m) => !['queued', 'running'].includes(m.state));
      if (!allDone || batch.emailedAt) return;
      this.store.updateBatch(batch.id, { state: 'done', finishedAt: new Date().toISOString(), emailedAt: new Date().toISOString() });
      const full = batch.reportIds.map((id) => this.store.loadReport(id)).filter(Boolean);
      const totalBroken = full.reduce((n, r) => n + (r.stats.broken || 0), 0);
      await this.mailer.send({
        to: owner.email,
        subject: `Multi check finished: ${totalBroken} broken link(s) across ${full.length} site(s)`,
        html: full.map((r) => reportSummaryHtml(r, base, { maxRows: 100 })).join('<hr style="margin:24px 0">'),
        attachments: full.map((r) => ({ filename: `linklantern-${new URL(r.startUrl).hostname}-${r.id}.csv`, content: reportToCsv(r, { only: 'problems' }) })),
      });
      return;
    }

    if (report.emailWhenDone && report.state !== 'stopped') {
      await this.mailer.send({
        to: owner.email,
        subject: `Site check finished: ${report.stats.broken || 0} broken link(s) on ${new URL(report.startUrl).hostname}`,
        html: reportSummaryHtml(report, base),
        attachments: [{ filename: `linklantern-${report.id}.csv`, content: reportToCsv(report, { only: 'problems' }) }],
      });
    }
  }
}
