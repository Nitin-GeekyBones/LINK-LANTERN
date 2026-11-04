import { $, $$, api, html, raw, num, when, host, stateBadge, toast } from '../common.js';

const TYPE = { site: 'Site check', multi: 'Multi check', auto: 'Auto check' };

export async function init() { load(); }

async function load() {
  const box = $('#reports');
  let data;
  try { data = await api('/api/reports'); } catch (err) { box.innerHTML = html`<p class="form-error">${err.message}</p>`; return; }
  if (!data.reports.length) {
    box.innerHTML = '<p class="empty panel">No reports yet. <a href="/site-check">Run a site check</a> while logged in and it will be saved here.</p>';
    return;
  }
  const rows = data.reports.map((r) => {
    const s = r.stats || {};
    const live = r.state === 'queued' || r.state === 'running';
    return html`<tr>
      <td class="url"><a href="/report/${r.id}">${host(r.startUrl)}</a><br><span class="small muted">${r.mode === 'page' ? 'single page' : 'whole site'}</span></td>
      <td>${TYPE[r.type] || r.type}</td>
      <td>${when(r.startedAt || r.createdAt)}</td>
      <td>${raw(stateBadge(r.state))}</td>
      <td>${num(s.linksChecked)}</td>
      <td>${raw(s.broken ? html`<span class="pill broken">${num(s.broken)}</span>` : r.fatal ? '<span class="pill skipped">—</span>' : '<span class="pill ok">0</span>')}</td>
      <td><div class="row-actions"><a class="btn btn-ghost btn-small" href="/report/${r.id}">Open</a>${raw(live ? '' : html`<button class="btn btn-ghost btn-small" data-del="${r.id}">Delete</button>`)}</div></td>
    </tr>`;
  }).join('');
  box.innerHTML = html`<div class="table-wrap"><table class="list"><thead><tr><th>Site</th><th>Type</th><th>Started</th><th>Status</th><th>Links checked</th><th>Broken</th><th></th></tr></thead><tbody>${raw(rows)}</tbody></table></div>`;
  $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this report permanently?')) return;
    try { await api(`/api/reports/${b.dataset.del}`, { method: 'DELETE', body: {} }); toast('Report deleted.'); } catch (e) { toast(e.message); }
    load();
  }));
}
