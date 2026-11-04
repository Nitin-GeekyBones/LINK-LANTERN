// Live + finished report view. Used inline after starting a site check and on
// /report/:id. Streams progress with Server-Sent Events, then loads the full
// report (every link) once the scan finishes.
import { $, $$, api, html, raw, num, esc, when, stateBadge, toast } from './common.js';

const RESULT_LABEL = { broken: 'Broken', redirect: 'Redirected', ok: 'OK', skipped: 'Not checked' };
const TABS = [
  ['broken', 'Broken'],
  ['redirect', 'Redirected'],
  ['skipped', 'Not checked'],
  ['all', 'All links'],
];
const PAGE_SIZE = 300;

export class ScanView {
  constructor(root, id, { onFinish, compact = false } = {}) {
    this.root = root;
    this.id = id;
    this.onFinish = onFinish;
    this.compact = compact;
    this.links = new Map();
    this.tab = 'broken';
    this.query = '';
    this.limit = PAGE_SIZE;
    this.complete = false; // links map holds every link (not just problems)
    this.ticker = [];
    this._renderTimer = null;
  }

  async start() {
    let data;
    try {
      data = await api(`/api/scans/${encodeURIComponent(this.id)}?links=0`);
    } catch (err) {
      this.root.innerHTML = html`<div class="banner error"><p>${err.message}</p></div>`;
      return;
    }
    this.report = data.report;
    this.renderShell();
    if (data.live) this.connect();
    else await this.loadFull();
  }

  stop() { if (this.es) this.es.close(); }

  // ------------------------------------------------------------ data
  connect() {
    const es = new EventSource(`/api/scans/${encodeURIComponent(this.id)}/events`);
    this.es = es;
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    on('snapshot', (d) => { this.report.state = d.state; this.report.queuePosition = d.queuePosition; this.updateStats(d.stats); });
    on('progress', (d) => { this.report.state = d.state; this.report.queuePosition = null; this.updateStats(d.stats); });
    on('queued', (d) => { this.report.queuePosition = d.position; this.updateHead(); });
    on('link', (l) => this.addLink(l));
    on('done', async (d) => {
      es.close();
      Object.assign(this.report, { state: d.state, fatal: d.fatal, stats: d.stats });
      await this.loadFull();
      this.onFinish?.(this.report);
    });
    es.onerror = () => {
      // connection dropped (server restart, network): fall back to polling once
      if (es.readyState === EventSource.CLOSED) setTimeout(() => this.loadFull(), 1500);
    };
  }

  async loadFull() {
    try {
      const data = await api(`/api/scans/${encodeURIComponent(this.id)}`);
      this.report = data.report;
      this.links = new Map(data.report.links.map((l) => [l.url, l]));
      this.complete = true;
      if (data.live && !this.es) this.connect();
    } catch (err) {
      toast(err.message);
    }
    this.renderShell();
  }

  addLink(l) {
    this.links.set(l.url, l);
    this.ticker.push(l);
    if (this.ticker.length > 40) this.ticker.shift();
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => { this.renderTicker(); this.renderTabs(); this.renderTable(); }, 250);
  }

  // ------------------------------------------------------------ rendering
  renderShell() {
    const r = this.report;
    this.root.hidden = false;
    this.root.innerHTML = html`
      <div class="scan-head">
        <div>
          <h2>${r.startUrl}</h2>
          <div data-head></div>
        </div>
        <div class="actions" data-actions></div>
      </div>
      <div class="gauges" data-gauges></div>
      <p class="now" data-now></p>
      <div class="ticker" data-ticker aria-hidden="true"></div>
      <div data-banners></div>
      <div class="filters">
        <div class="tabs" role="group" aria-label="Show" data-tabs></div>
        <label class="visually-hidden" for="scan-search-${this.id}">Filter links</label>
        <input type="search" id="scan-search-${this.id}" placeholder="Filter by URL or text" value="${this.query}">
      </div>
      <div class="table-wrap" data-table></div>`;
    $('input[type=search]', this.root).addEventListener('input', (e) => {
      this.query = e.target.value.trim().toLowerCase();
      this.limit = PAGE_SIZE;
      this.renderTable();
    });
    this.updateStats(r.stats || {});
    this.renderTicker();
    this.renderTabs();
    this.renderTable();
  }

  isLive() { return this.report.state === 'running' || this.report.state === 'queued'; }

  updateHead() {
    const r = this.report;
    const head = $('[data-head]', this.root);
    if (!head) return;
    const pos = r.state === 'queued' && r.queuePosition ? ` (position ${r.queuePosition} in the queue)` : '';
    const times = r.finishedAt ? `Finished ${when(r.finishedAt)}` : r.startedAt ? `Started ${when(r.startedAt)}` : '';
    const mode = r.mode === 'page' ? 'Single page' : `Whole site, depth ${r.options?.depth ?? 10}`;
    head.innerHTML = html`${raw(stateBadge(r.state, pos))} <span class="small muted">· ${mode}${times ? ` · ${times}` : ''}</span>`;

    const base = `/api/scans/${encodeURIComponent(this.id)}`;
    const actions = $('[data-actions]', this.root);
    const onReportPage = location.pathname.startsWith('/report/');
    actions.innerHTML = this.isLive()
      ? html`<button class="btn btn-ghost btn-small" data-stop>Stop scan</button>${raw(onReportPage ? '' : html`<a class="btn btn-ghost btn-small" href="/report/${this.id}">Open report page</a>`)}`
      : html`<a class="btn btn-small" href="${base}/export.csv" download>Download CSV</a>
             <a class="btn btn-ghost btn-small" href="${base}/export.csv?only=problems" download>Problems only (CSV)</a>
             <a class="btn btn-ghost btn-small" href="${base}/export.json" download>JSON</a>
             ${raw(onReportPage ? '' : html`<a class="btn btn-ghost btn-small" href="/report/${this.id}">Report page</a>`)}`;
    $('[data-stop]', actions)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await api(`${base}/stop`, { method: 'POST', body: {} }); toast('Stopping the scan…'); } catch (err) { toast(err.message); e.target.disabled = false; }
    });
  }

  updateStats(s = {}) {
    this.report.stats = s;
    this.updateHead();
    const g = $('[data-gauges]', this.root);
    if (g) {
      g.innerHTML = html`
        <div class="gauge"><b>${num(s.linksChecked)}</b><span>links checked${s.linksFound > s.linksChecked && this.isLive() ? ` of ${num(s.linksFound)} found` : ''}</span></div>
        <div class="gauge"><b>${num(s.pagesScanned)}</b><span>pages scanned</span></div>
        <div class="gauge broken"><b>${num(s.broken)}</b><span>broken</span></div>
        <div class="gauge redirect"><b>${num(s.redirected)}</b><span>redirected</span></div>
        <div class="gauge"><b>${num((s.skipped || 0) + (s.ignored || 0))}</b><span>not checked</span></div>`;
    }
    const now = $('[data-now]', this.root);
    if (now) now.textContent = this.isLive() && s.currentUrl ? `Checking ${s.currentUrl}` : '';
    this.renderBanners();
    this.renderTabs();
  }

  renderTicker() {
    const t = $('[data-ticker]', this.root);
    if (!t) return;
    if (!this.isLive()) { t.innerHTML = ''; return; }
    t.innerHTML = this.ticker.map((l) => html`<i class="pill ${l.result}">${l.status || l.error || ''}</i>`).join('');
  }

  renderBanners() {
    const r = this.report;
    const s = r.stats || {};
    const b = $('[data-banners]', this.root);
    if (!b) return;
    const out = [];
    if (r.fatal) out.push(html`<div class="banner error"><p><b>This check couldn't run.</b> ${r.fatal}</p><p class="small">Check the address and try again. If the site works in your browser, see <a href="/faq">why a site can look broken to a checker</a>.</p></div>`);
    if (s.limitReached) out.push(html`<div class="banner warn"><p>The check stopped collecting links at its limit of ${num(r.options?.maxLinks)}. Links beyond that weren't checked. ${raw(r.type === 'auto' ? '' : 'Scheduled scans on a <a href="/plans">paid plan</a> handle much larger sites.')}</p></div>`);
    if (s.pageLimitReached) out.push(html`<div class="banner warn"><p>Only the first ${num(r.options?.maxPages)} pages were opened and searched for links.</p></div>`);
    if (r.state === 'stopped') out.push(html`<div class="banner info"><p>This scan was stopped before it finished. Results below are partial.</p></div>`);
    if (r.state === 'done' && !r.fatal && !s.broken) out.push(html`<div class="banner good"><p><b>No broken links found.</b> ${num(s.linksChecked)} links on ${num(s.pagesScanned)} page${s.pagesScanned === 1 ? '' : 's'} all responded.</p></div>`);
    b.innerHTML = out.join('');
  }

  counts() {
    const s = this.report.stats || {};
    if (this.complete && !this.isLive()) {
      const c = { broken: 0, redirect: 0, skipped: 0, ok: 0 };
      for (const l of this.links.values()) c[l.result] = (c[l.result] || 0) + 1;
      return { ...c, all: this.links.size };
    }
    return { broken: s.broken || 0, redirect: s.redirected || 0, skipped: s.skipped || 0, all: s.linksFound || 0 };
  }

  renderTabs() {
    const t = $('[data-tabs]', this.root);
    if (!t) return;
    const c = this.counts();
    t.innerHTML = TABS.map(([id, label]) => html`<button type="button" data-tab="${id}" aria-pressed="${this.tab === id}">${label}<span class="n">${num(c[id])}</span></button>`).join('');
    $$('[data-tab]', t).forEach((btn) => btn.addEventListener('click', async () => {
      this.tab = btn.dataset.tab;
      this.limit = PAGE_SIZE;
      if (this.tab === 'all' && !this.complete) await this.loadFull();
      this.renderTabs();
      this.renderTable();
    }));
  }

  filtered() {
    const q = this.query;
    let list = [...this.links.values()];
    if (this.tab !== 'all') list = list.filter((l) => l.result === this.tab);
    if (q) {
      list = list.filter((l) => l.url.toLowerCase().includes(q) || (l.label || '').toLowerCase().includes(q)
        || (l.occurrences || []).some((o) => (o.text || '').toLowerCase().includes(q) || (o.page || '').toLowerCase().includes(q)));
    }
    const order = { broken: 0, redirect: 1, skipped: 2, ok: 3, pending: 4 };
    return list.sort((a, b) => (order[a.result] - order[b.result]) || (a.status || 0) - (b.status || 0));
  }

  renderTable() {
    const wrap = $('[data-table]', this.root);
    if (!wrap) return;
    const list = this.filtered();
    if (!list.length) {
      const msg = this.isLive()
        ? (this.tab === 'broken' ? 'No broken links yet. They will appear here as they are found.' : 'Nothing here yet.')
        : (this.query ? 'No links match that filter.' : this.tab === 'broken' ? 'No broken links. 🎉' : 'Nothing in this list.');
      wrap.innerHTML = html`<p class="empty">${msg}${raw(this.tab === 'all' && this.isLive() ? '<br><small>Working links are listed once the scan finishes.</small>' : '')}</p>`;
      return;
    }
    const rows = list.slice(0, this.limit).map((l) => this.row(l)).join('');
    const more = list.length > this.limit
      ? html`<button class="btn btn-ghost btn-small show-more" type="button" data-more>Show ${num(Math.min(PAGE_SIZE, list.length - this.limit))} more of ${num(list.length - this.limit)}</button>` : '';
    wrap.innerHTML = html`<table class="results">
      <thead><tr><th scope="col">Status</th><th scope="col">URL</th><th scope="col">Where it was found</th></tr></thead>
      <tbody>${raw(rows)}</tbody></table>${raw(more)}`;
    $('[data-more]', wrap)?.addEventListener('click', () => { this.limit += PAGE_SIZE; this.renderTable(); });
  }

  row(l) {
    const chain = (l.redirects || []).length
      ? html`<ul class="chain">${(l.redirects || []).map((h) => raw(html`<li>${h.status} → ${h.location || ''}</li>`))}</ul>` : '';
    const occ = l.occurrences || [];
    const first = occ[0];
    const where = l.isStart && !first
      ? html`<span class="muted">Starting URL</span>`
      : first
        ? html`${first.text}<span class="on-page">on <a href="${first.page}" target="_blank" rel="noopener nofollow">${first.page}</a></span>`
        : '';
    const extra = (l.occurrenceCount || occ.length) - 1;
    const moreList = extra > 0
      ? html`<details class="more"><summary>Found in ${num(extra)} more place${extra > 1 ? 's' : ''}</summary><ul>${occ.slice(1).map((o) => raw(html`<li>${o.text} <span class="on-page">on ${o.page}</span></li>`))}${raw(l.occurrenceCount > occ.length ? html`<li class="muted">…and ${num(l.occurrenceCount - occ.length)} more</li>` : '')}</ul></details>` : '';
    const label = l.label || RESULT_LABEL[l.result] || '';
    return html`<tr>
      <td><span class="pill ${l.result}" title="${RESULT_LABEL[l.result] || ''}">${label}</span></td>
      <td class="url"><a href="${l.url}" target="_blank" rel="noopener nofollow">${l.url}</a> <span class="tag">${l.error === 'INVALID_URL' ? '' : l.internal ? 'internal' : 'external'}</span>${raw(chain)}</td>
      <td class="src">${raw(where)}${raw(moreList)}</td>
    </tr>`;
  }
}

export { esc };
