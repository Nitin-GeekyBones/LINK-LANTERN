// Shared helpers for every page.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const str = v && v.__raw ? v.value : Array.isArray(v) ? v.map((x) => (x && x.__raw ? x.value : esc(x))).join('') : esc(v);
    return out + str + s;
  }, '');
}
export const raw = (value) => ({ __raw: true, value: String(value ?? '') });

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data);
  return data;
}

let metaPromise;
export function meta() {
  metaPromise ||= api('/api/meta');
  return metaPromise;
}

export const isUser = () => document.body.dataset.auth === 'user';

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

/** Wire a form: disables the submit button while busy and shows errors. */
export function handleForm(form, onSubmit) {
  if (!form) return;
  const err = $('.form-error', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    if (err) err.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await onSubmit(formData(form), form);
    } catch (ex) {
      if (err) err.textContent = ex.message || 'Something went wrong.';
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

export function toast(message, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = message;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export const num = (n) => Number(n || 0).toLocaleString();

export function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function host(url) { try { return new URL(url).host; } catch { return url; } }

export function nextParam(fallback = '/') {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : fallback;
}

export const STATE_LABEL = {
  queued: 'Waiting to start', running: 'Scanning', done: 'Finished', stopped: 'Stopped',
  error: 'Failed', interrupted: 'Interrupted',
};

export function stateBadge(state, extra = '') {
  return html`<span class="state" data-state="${state}"><span class="lamp" aria-hidden="true"></span>${STATE_LABEL[state] || state}${extra}</span>`;
}

// header log-out button (present on every page)
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-logout]');
  if (!btn) return;
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  location.href = '/';
});
