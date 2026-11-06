// Auto check: manage schedules, watch scans in progress.
import { $, $$, api, html, raw, isUser, isPaid, num, when, host, stateBadge, toast, formData, readChecklist, fillChecklist, initSlackOption } from '../common.js';

const FREQ = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };
let state = { schedules: [], limits: {}, active: [] };
let pollTimer = null;

export async function init() {
  if (!isUser()) return;
  const dialog = $('#schedule-dialog');
  const form = $('#schedule-form');
  $('#add-schedule').addEventListener('click', () => openDialog());
  $('[data-close]', form).addEventListener('click', () => dialog.close());
  form.runNow.addEventListener('change', () => { form.nextRun.disabled = form.runNow.checked; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.textContent = '';
    const d = formData(form);
    let nextRun;
    if (form.runNow.checked) nextRun = 'now';
    else if (form.nextRun.value) nextRun = new Date(form.nextRun.value).toISOString();
    const body = {
      url: d.url, frequency: d.frequency, depth: Number(d.depth), nextRun,
      ignore: d.ignore, intervalMs: Number(d.intervalMs), timeoutMs: Number(d.timeoutMs),
      restrictToDir: d.restrictToDir, overrideNofollow: d.overrideNofollow, suppressEmptyEmail: d.suppressEmptyEmail, active: d.active,
      notifySlack: !!d.slack,
      ...(isPaid() ? { checklist: readChecklist(d) } : {}),
    };
    try {
      if (d.scheduleId) await api(`/api/schedules/${d.scheduleId}`, { method: 'PUT', body });
      else await api('/api/schedules', { method: 'POST', body });
      dialog.close();
      toast(d.scheduleId ? 'Schedule saved.' : 'Site added to your schedule.');
      load();
    } catch (ex) { err.textContent = ex.message; }
  });
  initSlackOption(form);
  load();
}

function toLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openDialog(s = null) {
  const form = $('#schedule-form');
  form.reset();
  $('.form-error', form).textContent = '';
  $('#schedule-dialog-title').textContent = s ? 'Edit schedule' : 'Add a site';
  form.scheduleId.value = s?.id || '';
  form.url.value = s?.url || '';
  form.frequency.value = s?.frequency || 'weekly';
  form.depth.value = s?.depth ?? 10;
  form.nextRun.value = toLocalInput(s?.nextRun);
  form.runNow.checked = !s;
  form.nextRun.disabled = !s;
  form.ignore.value = (s?.ignore || []).join('\n');
  form.intervalMs.value = s?.intervalMs ?? 0;
  form.timeoutMs.value = s?.timeoutMs ?? 15000;
  form.restrictToDir.checked = !!s?.restrictToDir;
  form.overrideNofollow.checked = !!s?.overrideNofollow;
  form.suppressEmptyEmail.checked = !!s?.suppressEmptyEmail;
  form.active.checked = s ? s.active : true;
  if (!form.slack.disabled) form.slack.checked = !!s?.notifySlack;
  fillChecklist(form, s?.checklist);
  $('details.advanced', form).open = !!(s && (s.ignore?.length || s.intervalMs || s.restrictToDir || s.overrideNofollow || s.suppressEmptyEmail || s.notifySlack || !s.active));
  $('#schedule-dialog').showModal();
  form.url.focus();
}

async function load() {
  clearTimeout(pollTimer);
  try {
    state = await api('/api/schedules');
  } catch (err) {
    $('#schedules').innerHTML = html`<p class="form-error">${err.message}</p>`;
    return;
  }
  const L = state.limits;
  const pct = L.monthlyLinks ? Math.min(100, Math.round((L.usedThisMonth / L.monthlyLinks) * 100)) : 0;
  $('#usage-bar').style.width = `${pct}%`;
  $('.meter').setAttribute('aria-valuenow', String(pct));
  $('#usage-text').textContent = L.monthlyLinks
    ? `${num(L.usedThisMonth)} of ${num(L.monthlyLinks)} links used. Resets on the 1st.`
    : 'Your plan has no scheduled-scan allowance.';
  $('#sites-text').textContent = `${state.schedules.length} of ${L.autoSites} site${L.autoSites === 1 ? '' : 's'} used on your plan.`;
  $('#upgrade-note').hidden = L.autoSites > 0;
  $('#add-schedule').disabled = state.schedules.length >= L.autoSites;

  renderSchedules();
  renderActive();
  pollTimer = setTimeout(load, state.active.length ? 3000 : 20000);
}

function renderSchedules() {
  const box = $('#schedules');
  if (!state.schedules.length) {
    box.innerHTML = state.limits.autoSites
      ? '<p class="empty panel">No sites scheduled yet. Use "Add a site" to set up your first automatic check.</p>'
      : '<p class="muted">Scheduled sites will be listed here once your plan includes Auto check.</p>';
    return;
  }
  const rows = state.schedules.map((s) => {
    const last = s.lastSummary;
    const lastCell = s.runningReportId
      ? html`<a href="/report/${s.runningReportId}">${raw(stateBadge('running'))}</a>`
      : last
        ? html`${raw(last.fatal ? '<span class="pill broken">Failed</span>' : last.broken ? html`<span class="pill broken">${num(last.broken)} broken</span>` : '<span class="pill ok">All good</span>')}
               <span class="small muted">${when(s.lastRunAt)}</span> ${raw(s.lastReportId ? html`<a class="small" href="/report/${s.lastReportId}">report</a>` : '')}`
        : s.lastError ? html`<span class="small form-error">${s.lastError}</span>` : html`<span class="muted small">Not run yet</span>`;
    return html`<tr>
      <td class="url">${s.url}${raw(s.active ? '' : ' <span class="tag">paused</span>')}${raw(s.notifySlack ? ' <span class="tag">Slack</span>' : '')}${raw(s.checklist ? ' <span class="tag">checklist</span>' : '')}</td>
      <td>${FREQ[s.frequency]}<br><span class="small muted">depth ${s.depth}</span></td>
      <td>${s.active ? when(s.nextRun) : '—'}</td>
      <td>${raw(lastCell)}</td>
      <td><div class="row-actions">
        <button class="btn btn-ghost btn-small" data-run="${s.id}" ${s.runningReportId ? 'disabled' : ''}>Run now</button>
        <button class="btn btn-ghost btn-small" data-edit="${s.id}">Edit</button>
        <button class="btn btn-ghost btn-small" data-toggle="${s.id}">${s.active ? 'Pause' : 'Resume'}</button>
        <button class="btn btn-ghost btn-small" data-delete="${s.id}">Delete</button>
      </div></td></tr>`;
  }).join('');
  box.innerHTML = html`<div class="table-wrap"><table class="list"><thead><tr><th>Site</th><th>Frequency</th><th>Next scan</th><th>Last scan</th><th></th></tr></thead><tbody>${raw(rows)}</tbody></table></div>`;

  const find = (id) => state.schedules.find((s) => s.id === id);
  $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => openDialog(find(b.dataset.edit))));
  $$('[data-run]', box).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/schedules/${b.dataset.run}/run`, { method: 'POST', body: {} }); toast('Scan started.'); } catch (e) { toast(e.message); }
    load();
  }));
  $$('[data-toggle]', box).forEach((b) => b.addEventListener('click', async () => {
    const s = find(b.dataset.toggle);
    try { await api(`/api/schedules/${s.id}`, { method: 'PUT', body: { active: !s.active } }); } catch (e) { toast(e.message); }
    load();
  }));
  $$('[data-delete]', box).forEach((b) => b.addEventListener('click', async () => {
    const s = find(b.dataset.delete);
    if (!confirm(`Delete the schedule for ${host(s.url)}? Past reports are kept.`)) return;
    try { await api(`/api/schedules/${s.id}`, { method: 'DELETE', body: {} }); toast('Schedule deleted.'); } catch (e) { toast(e.message); }
    load();
  }));
}

function renderActive() {
  const box = $('#active-scans');
  if (!state.active.length) { box.innerHTML = '<p class="muted">No scheduled scans are running right now.</p>'; return; }
  box.innerHTML = state.active.map((r) => {
    const s = r.stats || {};
    return html`<div class="panel">
      <p><b class="mono">${r.startUrl}</b><br>${raw(stateBadge(r.state))} <span class="small muted">· started ${when(r.startedAt || r.createdAt)}</span></p>
      <p class="small">${num(s.pagesScanned)} pages · ${num(s.linksChecked)} of ${num(s.linksFound)} links checked · <b>${num(s.broken)} broken</b></p>
      <p class="now">${s.currentUrl ? `Checking ${s.currentUrl}` : ''}</p>
      <div class="row-actions"><a class="btn btn-small" href="/report/${r.id}">View results so far</a><button class="btn btn-ghost btn-small" data-end="${r.id}">End scan</button></div>
    </div>`;
  }).join('');
  $$('[data-end]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('End this scan now? Results so far are saved and emailed.')) return;
    try { await api(`/api/scans/${b.dataset.end}/stop`, { method: 'POST', body: {} }); toast('Scan ending…'); } catch (e) { toast(e.message); }
    setTimeout(load, 800);
  }));
}
