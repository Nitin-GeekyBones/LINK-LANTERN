import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { Store } from './store.js';
import { createAuth, hashPassword, verifyPassword, publicUser } from './auth.js';
import { createCaptcha } from './captcha.js';
import { createMailer } from './mailer.js';
import { createHttpClient } from './crawler/http.js';
import { normalizeStartUrl } from './crawler/Crawler.js';
import { ERROR_CODES, HTTP_STATUS } from './crawler/statusCodes.js';
import { ScanManager, ScanError } from './scanManager.js';
import { startScheduler, startSchedule, nextAfterNow } from './scheduler.js';
import { PLANS, getPlan } from './plans.js';
import { reportToCsv, captchaToCsv, matchesToCsv } from './reportFormat.js';
import { newId } from './store.js';
import { normalizeChecklist, CHECKLIST_PRESETS } from './crawler/detect.js';
import { createSlack, validateWebhookUrl, buildSlackMessage } from './slack.js';

// ------------------------------------------------------------------ wiring
const store = new Store(config.dataDir);
const mailer = createMailer({ config, outboxDir: store.outboxDir });
const http = createHttpClient({
  userAgent: config.crawler.userAgent,
  allowPrivateNetworks: config.crawler.allowPrivateNetworks,
  maxBodyBytes: config.crawler.maxBodyBytes,
  maxRedirects: config.crawler.maxRedirects,
});
const slack = createSlack();
const scans = new ScanManager({ store, config, mailer, http, slack });
const auth = createAuth({ store, config });
const captcha = createCaptcha();

scans.markInterrupted();
const purged = store.purgeGuestReports(config.scans.guestReportTtlDays);
if (purged) console.log(`[store] removed ${purged} expired guest report(s)`);
setInterval(() => store.purgeGuestReports(config.scans.guestReportTtlDays), 3600000).unref();
const scheduler = startScheduler({ store, scans, config });

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Tiny fixed-window rate limiter keyed by string. */
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    return h.n <= limit;
  };
}
const authLimit = rateLimiter(20, 15 * 60 * 1000);
const guestScanLimit = rateLimiter(config.scans.guestScansPerHour, 60 * 60 * 1000);
const userScanLimit = rateLimiter(60, 60 * 60 * 1000);

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function canView(req, meta) {
  return !meta.owner || (req.user && req.user.id === meta.owner);
}

function limitsFor(user) {
  const plan = getPlan(user?.plan);
  return {
    plan: plan.id,
    manualMaxLinks: config.scans.manualMaxLinks,
    manualMaxPages: config.scans.manualMaxPages,
    autoSites: plan.autoSites,
    monthlyLinks: plan.monthlyLinks,
    usedThisMonth: user ? store.getUsage(user.id) : 0,
    multiMaxSites: config.scans.multiMaxSites,
    checklist: !!plan.checklist,
  };
}

/**
 * Validate the optional checklist / Slack settings sent with a scan or schedule.
 * The content checklist needs a paid plan; Slack needs a saved webhook.
 */
function scanExtras(user, body, existing = {}) {
  const fail = (message, status = 400) => { const e = new ScanError(message, status); e.field = 'extras'; throw e; };
  // Only settings sent in this request are enforced; ones carried over from an
  // existing schedule are kept as they are (e.g. pausing it still works after
  // the Slack webhook was removed - the scheduler skips Slack then).
  if (body.checklist === undefined && body.slack === undefined) return { checklist: existing.checklist || null, slack: !!existing.slack };
  let checklist = existing.checklist || null;
  if (body.checklist !== undefined) {
    try { checklist = normalizeChecklist(body.checklist); } catch (err) { fail(err.message); }
    if (checklist && !getPlan(user?.plan).checklist) fail('The content checklist is part of the paid plans. Choose one on the Plans page.', 402);
  }
  let slackOn = !!existing.slack;
  if (body.slack !== undefined) {
    slackOn = !!body.slack;
    if (slackOn && !user?.slackWebhookUrl) fail('Add a Slack webhook in Account settings before sending reports to Slack.');
  }
  return { checklist, slack: slackOn };
}

// ------------------------------------------------------------------ app
const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});
app.use(express.json({ limit: '200kb' }));
app.use(auth.middleware);

// CSRF defence for the JSON API: state-changing requests must be JSON (which a
// cross-site HTML form cannot send) and, when an Origin header is present, it
// must match this host. Session cookies are also SameSite=Lax.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Requests must be sent as JSON.' });
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request refused.' }); } catch { return res.status(403).json({ error: 'Bad origin.' }); }
    }
  }
  res.set('cache-control', 'no-store');
  next();
});

// ------------------------------------------------------------------ meta & captcha
app.get('/api/meta', (req, res) => {
  res.json({
    plans: Object.values(PLANS),
    billingMode: config.billingMode,
    captchaEnabled: config.captchaEnabled,
    limits: limitsFor(req.user),
    user: publicUser(req.user),
    userAgent: config.crawler.userAgent,
    errorCodes: ERROR_CODES,
    httpStatus: HTTP_STATUS,
    checklistPresets: Object.entries(CHECKLIST_PRESETS).map(([id, p]) => ({ id, label: p.label })),
  });
});

app.get('/api/captcha', (req, res) => {
  if (!config.captchaEnabled || req.user) return res.json({ required: false });
  const c = captcha.create();
  res.json({ required: true, id: c.id, image: `data:image/svg+xml;base64,${Buffer.from(c.svg).toString('base64')}` });
});

// ------------------------------------------------------------------ auth
app.post('/api/auth/signup', ah(async (req, res) => {
  if (!authLimit(`signup:${req.ip}`)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (store.getUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
  const user = store.createUser({ email, passwordHash: await hashPassword(password) });
  auth.issue(res, user);
  mailer.send({
    to: email,
    subject: 'Welcome to LinkLantern',
    html: `<p>Your LinkLantern account is ready.</p><p>Run a <a href="${config.baseUrl}/multi-check">Multi check</a> across several sites, or set up <a href="${config.baseUrl}/auto-check">Auto check</a> to scan on a schedule.</p>`,
  }).catch(() => {});
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  if (!authLimit(`login:${req.ip}`)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const user = store.getUserByEmail(req.body.email);
  const ok = user && await verifyPassword(String(req.body.password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
  auth.issue(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => { auth.clear(res); res.json({ ok: true }); });

app.post('/api/auth/forgot', ah(async (req, res) => {
  if (!authLimit(`forgot:${req.ip}`)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const user = store.getUserByEmail(req.body.email);
  if (user) {
    const token = store.addResetToken(user.id);
    await mailer.send({
      to: user.email,
      subject: 'Reset your LinkLantern password',
      html: `<p>Someone (hopefully you) asked to reset the password for this account.</p><p><a href="${config.baseUrl}/reset?token=${token}">Choose a new password</a> - this link works for one hour.</p><p>If you didn't ask, you can ignore this email.</p>`,
    });
  }
  res.json({ ok: true, outbox: !mailer.configured });
}));

app.post('/api/auth/reset', ah(async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const userId = store.consumeResetToken(req.body.token);
  if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  const user = store.getUser(userId);
  store.updateUser(userId, { passwordHash: await hashPassword(password), sessionVersion: (user.sessionVersion || 1) + 1 });
  auth.issue(res, store.getUser(userId));
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => {
  res.json({ user: publicUser(req.user), limits: limitsFor(req.user) });
});

app.put('/api/account/email', auth.requireUser, ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!await verifyPassword(String(req.body.password || ''), req.user.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
  const other = store.getUserByEmail(email);
  if (other && other.id !== req.user.id) return res.status(409).json({ error: 'That email is already used by another account.' });
  store.updateUser(req.user.id, { email });
  res.json({ user: publicUser(store.getUser(req.user.id)) });
}));

app.put('/api/account/password', auth.requireUser, ah(async (req, res) => {
  if (!await verifyPassword(String(req.body.current || ''), req.user.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const u = store.updateUser(req.user.id, { passwordHash: await hashPassword(password), sessionVersion: (req.user.sessionVersion || 1) + 1 });
  auth.issue(res, u); // other sessions are now logged out
  res.json({ ok: true });
}));

app.post('/api/account/plan', auth.requireUser, (req, res) => {
  if (config.billingMode !== 'demo') return res.status(403).json({ error: 'Plan changes are handled by the billing provider.' });
  const plan = PLANS[req.body.plan];
  if (!plan) return res.status(400).json({ error: 'Unknown plan.' });
  const cycle = req.body.cycle === 'yearly' ? 'yearly' : 'monthly';
  const count = store.listSchedules(req.user.id).length;
  if (count > plan.autoSites) {
    return res.status(409).json({ error: `You have ${count} scheduled sites; the ${plan.name} plan allows ${plan.autoSites}. Remove some schedules first.` });
  }
  const u = store.updateUser(req.user.id, { plan: plan.id, billingCycle: cycle });
  res.json({ user: publicUser(u), limits: limitsFor(u) });
});

app.put('/api/account/slack', auth.requireUser, (req, res) => {
  const raw = String(req.body.webhookUrl || '').trim();
  let url = null;
  if (raw) {
    try { url = validateWebhookUrl(raw); } catch (err) { return res.status(400).json({ error: err.message }); }
  }
  const u = store.updateUser(req.user.id, { slackWebhookUrl: url });
  res.json({ user: publicUser(u) });
});

app.post('/api/account/slack/test', auth.requireUser, ah(async (req, res) => {
  if (!req.user.slackWebhookUrl) return res.status(400).json({ error: 'Save a Slack webhook URL first.' });
  if (!authLimit(`slack-test:${req.user.id}`)) return res.status(429).json({ error: 'Too many test messages. Try again later.' });
  try {
    await slack.post(req.user.slackWebhookUrl, {
      text: 'LinkLantern is connected to this channel.',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: *LinkLantern is connected.* Reports you send to Slack will appear in this channel.' } }],
    });
  } catch (err) {
    return res.status(502).json({ error: `Slack didn't accept the test message (${err.message}).` });
  }
  res.json({ ok: true });
}));

app.delete('/api/account', auth.requireUser, ah(async (req, res) => {
  if (!await verifyPassword(String(req.body.password || ''), req.user.passwordHash)) return res.status(401).json({ error: 'Password is incorrect.' });
  for (const e of scans.listActive(req.user.id)) scans.stop(e.id);
  store.deleteUser(req.user.id);
  auth.clear(res);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ scans
app.post('/api/scans', (req, res) => {
  const user = req.user;
  const ip = req.ip;
  if (!user && config.captchaEnabled && !captcha.verify(req.body.captchaId, req.body.captchaAnswer)) {
    return res.status(400).json({ error: 'The security code was not correct. Please try the new one.', field: 'captcha' });
  }
  if (!(user ? userScanLimit(user.id) : guestScanLimit(ip))) {
    return res.status(429).json({ error: 'You have started a lot of scans recently. Please wait a while before starting another.' });
  }
  try {
    const extras = scanExtras(user, req.body);
    const report = scans.createScan({
      owner: user?.id || null, ip, type: 'site',
      url: req.body.url, mode: req.body.mode === 'page' ? 'page' : 'site',
      limits: { maxLinks: config.scans.manualMaxLinks, maxPages: config.scans.manualMaxPages },
      options: { depth: config.crawler.defaultDepth },
      emailWhenDone: !!(user && req.body.emailWhenDone),
      ...extras,
    });
    res.status(201).json({ id: report.id, report });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, field: err.field || (err instanceof ScanError ? undefined : 'url') });
  }
});

app.get('/api/scans/active', auth.requireUser, (req, res) => {
  res.json({ scans: scans.listActive(req.user.id) });
});

function loadViewable(req, res, withLinks) {
  const r = scans.getReport(req.params.id, { withLinks });
  if (!r || !canView(req, r)) { res.status(404).json({ error: 'Report not found. Guest reports are kept for 7 days.' }); return null; }
  return r;
}

app.get('/api/scans/:id', (req, res) => {
  const r = loadViewable(req, res, req.query.links !== '0');
  if (r) res.json({ report: r, live: scans.isLive(r.id) });
});

app.get('/api/scans/:id/events', (req, res) => {
  const r = scans.getReport(req.params.id);
  if (!r || !canView(req, r)) return res.status(404).end();
  scans.subscribe(req.params.id, res);
});

app.post('/api/scans/:id/stop', (req, res) => {
  const r = scans.getReport(req.params.id);
  if (!r || !canView(req, r)) return res.status(404).json({ error: 'Report not found.' });
  if (!scans.stop(req.params.id)) return res.status(409).json({ error: 'That scan has already finished.' });
  res.json({ ok: true });
});

app.get('/api/scans/:id/export.:fmt', (req, res) => {
  const r = loadViewable(req, res, true);
  if (!r) return;
  const host = (() => { try { return new URL(r.startUrl).hostname; } catch { return 'site'; } })();
  const date = (r.finishedAt || r.createdAt || '').slice(0, 10);
  if (req.params.fmt === 'csv') {
    // ?section=links (default) | captcha | matches
    const section = ['captcha', 'matches'].includes(req.query.section) ? req.query.section : 'links';
    const suffix = { links: '', captcha: '-captcha', matches: '-text-matches' }[section];
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', `attachment; filename="linklantern-${host}-${date}${suffix}.csv"`);
    if (section === 'captcha') return res.send(captchaToCsv(r));
    if (section === 'matches') return res.send(matchesToCsv(r));
    return res.send(reportToCsv(r, { only: req.query.only === 'problems' ? 'problems' : 'all' }));
  }
  if (req.params.fmt === 'json') {
    res.set('content-disposition', `attachment; filename="linklantern-${host}-${date}.json"`);
    return res.json(r);
  }
  res.status(404).json({ error: 'Unknown export format.' });
});

// ------------------------------------------------------------------ reports & multi check
app.get('/api/reports', auth.requireUser, (req, res) => {
  const reports = store.listReports(req.user.id).map((r) => (scans.isLive(r.id) ? scans.getReport(r.id) : r));
  res.json({ reports });
});

app.delete('/api/reports/:id', auth.requireUser, (req, res) => {
  const r = store.getReportMeta(req.params.id);
  if (!r || r.owner !== req.user.id) return res.status(404).json({ error: 'Report not found.' });
  if (scans.isLive(r.id)) return res.status(409).json({ error: 'Stop the scan before deleting its report.' });
  store.deleteReport(r.id);
  res.json({ ok: true });
});

app.post('/api/multi', auth.requireUser, (req, res) => {
  const raw = Array.isArray(req.body.urls) ? req.body.urls : String(req.body.urls || '').split(/[\s,]+/);
  const urls = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
  if (!urls.length) return res.status(400).json({ error: 'Enter at least one website address.' });
  if (urls.length > config.scans.multiMaxSites) return res.status(400).json({ error: `Multi check accepts up to ${config.scans.multiMaxSites} sites at a time.` });
  const bad = [];
  for (const u of urls) { try { normalizeStartUrl(u); } catch (e) { bad.push(`${u}: ${e.message}`); } }
  if (bad.length) return res.status(400).json({ error: `Please fix these addresses:\n${bad.join('\n')}` });
  let extras;
  try { extras = scanExtras(req.user, req.body); } catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  if (!userScanLimit(req.user.id)) return res.status(429).json({ error: 'Too many scans started recently. Please wait a while.' });
  const batch = { id: newId(9), owner: req.user.id, createdAt: new Date().toISOString(), state: 'running', reportIds: [], mode: req.body.mode === 'page' ? 'page' : 'site', slack: extras.slack };
  store.addBatch(batch);
  for (const url of urls) {
    const r = scans.createScan({
      owner: req.user.id, ip: req.ip, type: 'multi', url, mode: batch.mode, batchId: batch.id, skipActiveCheck: true,
      limits: { maxLinks: config.scans.manualMaxLinks, maxPages: config.scans.manualMaxPages },
      options: { depth: config.crawler.defaultDepth },
      checklist: extras.checklist, // Slack goes out once per batch, not per site
    });
    batch.reportIds.push(r.id);
  }
  store.updateBatch(batch.id, { reportIds: batch.reportIds });
  res.status(201).json({ batch });
});

app.get('/api/multi', auth.requireUser, (req, res) => {
  const batches = store.listBatches(req.user.id).slice(0, 20).map((b) => ({
    ...b,
    reports: b.reportIds.map((id) => scans.getReport(id) || store.getReportMeta(id)).filter(Boolean),
  }));
  res.json({ batches, mailConfigured: mailer.configured });
});

// ------------------------------------------------------------------ auto check schedules
const FREQS = new Set(['daily', 'weekly', 'monthly']);
function parseSchedule(user, body, existing = {}) {
  const out = {};
  if (body.url !== undefined || !existing.url) {
    // Validate, but keep a scheme-less address as typed so each run can fall
    // back from https:// to http:// (the first successful run pins the scheme).
    const n = normalizeStartUrl(body.url);
    out.url = n.hadScheme ? n.url : String(body.url).trim().replace(/#.*$/, '');
  }
  const freq = body.frequency ?? existing.frequency ?? 'weekly';
  if (!FREQS.has(freq)) throw new Error('Frequency must be daily, weekly or monthly.');
  out.frequency = freq;
  if (body.nextRun === 'now') out.nextRun = new Date().toISOString();
  else if (body.nextRun) {
    const t = Date.parse(body.nextRun);
    if (!Number.isFinite(t)) throw new Error('Next run time is not a valid date.');
    out.nextRun = new Date(t).toISOString();
  } else if (!existing.nextRun) out.nextRun = new Date().toISOString();
  const depth = body.depth ?? existing.depth ?? config.crawler.defaultDepth;
  out.depth = Math.min(Math.max(parseInt(depth, 10) || 0, 0), config.crawler.maxDepth);
  const ignore = body.ignore ?? existing.ignore ?? [];
  out.ignore = (Array.isArray(ignore) ? ignore : String(ignore).split(/\r?\n/)).map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const interval = body.intervalMs ?? existing.intervalMs ?? 0;
  out.intervalMs = Math.min(Math.max(parseInt(interval, 10) || 0, 0), config.crawler.maxCrawlDelayMs);
  const timeout = body.timeoutMs ?? existing.timeoutMs ?? config.crawler.timeoutMs;
  out.timeoutMs = Math.min(Math.max(parseInt(timeout, 10) || config.crawler.timeoutMs, 2000), config.crawler.maxTimeoutMs);
  for (const k of ['overrideNofollow', 'suppressEmptyEmail', 'restrictToDir']) out[k] = !!(body[k] ?? existing[k] ?? false);
  out.active = body.active === undefined ? (existing.active ?? true) : !!body.active;
  const extras = scanExtras(user, { checklist: body.checklist, slack: body.notifySlack }, { checklist: existing.checklist, slack: existing.notifySlack });
  out.checklist = extras.checklist;
  out.notifySlack = extras.slack;
  return out;
}

app.get('/api/schedules', auth.requireUser, (req, res) => {
  const list = store.listSchedules(req.user.id).map((s) => ({ ...s, runningReportId: scans.activeForSchedule(s.id) }));
  res.json({ schedules: list, limits: limitsFor(req.user), active: scans.listActive(req.user.id).filter((s) => s.type === 'auto') });
});

app.post('/api/schedules', auth.requireUser, (req, res) => {
  const plan = getPlan(req.user.plan);
  if (!plan.autoSites) return res.status(402).json({ error: 'Auto check needs a paid plan. Choose one on the Plans page.' });
  if (store.listSchedules(req.user.id).length >= plan.autoSites) {
    return res.status(409).json({ error: `Your ${plan.name} plan allows ${plan.autoSites} scheduled site(s). Upgrade or remove one first.` });
  }
  try {
    const s = { id: newId(9), owner: req.user.id, createdAt: new Date().toISOString(), ...parseSchedule(req.user, req.body) };
    store.addSchedule(s);
    if (Date.parse(s.nextRun) <= Date.now() + 1000) scheduler.tick();
    res.status(201).json({ schedule: store.getSchedule(s.id) });
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

app.put('/api/schedules/:id', auth.requireUser, (req, res) => {
  const s = store.getSchedule(req.params.id);
  if (!s || s.owner !== req.user.id) return res.status(404).json({ error: 'Schedule not found.' });
  try {
    const patch = parseSchedule(req.user, req.body, s);
    store.updateSchedule(s.id, patch);
    if (Date.parse(patch.nextRun) <= Date.now() + 1000) scheduler.tick();
    res.json({ schedule: store.getSchedule(s.id) });
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

app.delete('/api/schedules/:id', auth.requireUser, (req, res) => {
  const s = store.getSchedule(req.params.id);
  if (!s || s.owner !== req.user.id) return res.status(404).json({ error: 'Schedule not found.' });
  const running = scans.activeForSchedule(s.id);
  if (running) scans.stop(running);
  store.deleteSchedule(s.id);
  res.json({ ok: true });
});

app.post('/api/schedules/:id/run', auth.requireUser, (req, res) => {
  const s = store.getSchedule(req.params.id);
  if (!s || s.owner !== req.user.id) return res.status(404).json({ error: 'Schedule not found.' });
  try {
    const r = startSchedule({ store, scans, config }, s, { manual: true });
    if (r.error) return res.status(409).json({ error: r.error });
    res.status(201).json({ report: r.report });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ------------------------------------------------------------------ pages
const VIEWS = path.join(config.root, 'views');
const read = (f) => fs.readFileSync(path.join(VIEWS, f), 'utf8');
const cache = new Map();
const tpl = (f) => {
  if (process.env.NODE_ENV === 'production' && cache.has(f)) return cache.get(f);
  const t = read(f);
  cache.set(f, t);
  return t;
};

const NAV = [
  ['site', '/site-check', 'Site check'],
  ['multi', '/multi-check', 'Multi check'],
  ['auto', '/auto-check', 'Auto check'],
  ['reports', '/reports', 'My reports', true],
  ['plans', '/plans', 'Plans'],
  ['faq', '/faq', 'FAQ'],
];

function renderErrorCodes() {
  const custom = Object.entries(ERROR_CODES).map(([code, v]) => `<tr><th scope="row">${esc(v.label)}</th><td>${esc(v.help)}</td></tr>`).join('');
  const groups = [
    ['3xx Redirection', (c) => c >= 300 && c < 400],
    ['4xx Client errors', (c) => c >= 400 && c < 500],
    ['5xx Server errors', (c) => c >= 500 && c < 600],
  ];
  const http = groups.map(([title, f]) => `<h3>${title}</h3><dl class="codes">${Object.entries(HTTP_STATUS).filter(([c]) => f(+c)).map(([c, t]) => `<div><dt>${c}</dt><dd>${esc(t)}</dd></div>`).join('')}</dl>`).join('');
  return { customCodes: custom, httpCodes: http };
}

function renderPlans(user) {
  const plans = Object.values(PLANS);
  const head = plans.map((p) => `<th scope="col" class="${p.popular ? 'popular' : ''}">${p.popular ? '<span class="badge">Most popular</span>' : ''}<span class="plan-name">${esc(p.name)}</span><small>${esc(p.tagline)}</small></th>`).join('');
  const yes = '<span class="yes" aria-label="Included">✓</span>';
  const no = '<span class="no" aria-label="Not included">—</span>';
  const row = (label, f) => `<tr><th scope="row">${label}</th>${plans.map((p) => `<td class="${p.popular ? 'popular' : ''}">${f(p)}</td>`).join('')}</tr>`;
  const price = (p) => (p.priceMonthly ? `<span class="price">$${p.priceMonthly}</span>/mo<br><small>or $${p.priceYearly}/yr</small>` : '<span class="price">$0</span>');
  const cta = (p) => {
    if (!user) return p.id === 'free' ? '<a class="btn btn-ghost" href="/site-check">Check a site</a>' : `<a class="btn" href="/signup?plan=${p.id}">Sign up</a>`;
    if (user.plan === p.id) return '<span class="current">Current plan</span>';
    if (config.billingMode !== 'demo') return '';
    return `<button class="btn ${p.id === 'free' ? 'btn-ghost' : ''}" data-choose-plan="${p.id}">${p.id === 'free' ? 'Downgrade' : 'Choose'}</button>`;
  };
  return `<table class="plans">
<thead><tr><td></td>${head}</tr></thead>
<tbody>
${row('Check one site or page', () => yes)}
${row(`Links per manual check`, () => config.scans.manualMaxLinks.toLocaleString('en-US'))}
${row('Check a list of sites, report by email', () => yes)}
${row('Scheduled automatic checks', (p) => (p.autoSites ? `${yes}<br><small>up to ${p.autoSites} site${p.autoSites > 1 ? 's' : ''}</small>` : no))}
${row('Links checked per month (auto)', (p) => (p.monthlyLinks ? p.monthlyLinks.toLocaleString('en-US') : no))}
${row('Ignore lists, crawl interval, timeouts', (p) => (p.autoSites ? yes : no))}
${row('reCAPTCHA detection on every scanned page', () => yes)}
${row('Content checklist: find emails, phone numbers and your own text', (p) => (p.checklist ? yes : no))}
${row('Reports to Slack', () => yes)}
${row('CSV / JSON export', () => yes)}
${row('Price', price)}
${row('', cta)}
</tbody></table>`;
}

const PAGES = {
  '/': { view: 'home', title: 'Free broken link checker', nav: 'site', description: 'Find broken links, redirect chains and dead images on any website. Free online link checker with scheduled scans and CSV reports.' },
  '/site-check': { view: 'site-check', title: 'Site check', nav: 'site', description: 'Scan a whole website or a single page for broken links.' },
  '/multi-check': { view: 'multi-check', title: 'Multi check', nav: 'multi', description: 'Check several websites in one go and get the report by email.' },
  '/auto-check': { view: 'auto-check', title: 'Auto check', nav: 'auto', description: 'Scheduled broken link scans with emailed reports.' },
  '/reports': { view: 'reports', title: 'My reports', nav: 'reports', auth: true },
  '/report/:id': { view: 'report', title: 'Link report', nav: '' },
  '/plans': { view: 'plans', title: 'Plans & pricing', nav: 'plans', vars: (req) => ({ plansTable: renderPlans(req.user) }) },
  '/faq': { view: 'faq', title: 'Frequently asked questions', nav: 'faq', vars: () => ({ userAgent: esc(config.crawler.userAgent), token: config.crawler.userAgentToken }) },
  '/error-codes': { view: 'error-codes', title: 'Status & error codes', nav: '', vars: renderErrorCodes },
  '/features': { view: 'features', title: 'Features', nav: '' },
  '/about': { view: 'about', title: 'About', nav: '', vars: () => ({ userAgent: esc(config.crawler.userAgent), token: config.crawler.userAgentToken }) },
  '/terms': { view: 'terms', title: 'Terms & privacy', nav: '' },
  '/sitemap': { view: 'sitemap', title: 'Sitemap', nav: '' },
  '/login': { view: 'login', title: 'Log in', nav: '' },
  '/signup': { view: 'signup', title: 'Create a free account', nav: '' },
  '/forgot': { view: 'forgot', title: 'Forgotten password', nav: '' },
  '/reset': { view: 'reset', title: 'Choose a new password', nav: '' },
  '/account': { view: 'account', title: 'Account settings', nav: '', auth: true },
};

function render(req, res, page, status = 200) {
  const vars = {
    title: esc(page.title),
    description: esc(page.description || 'LinkLantern finds broken links on your website.'),
    pageId: page.view,
    auth: req.user ? 'user' : 'guest',
    planTier: req.user && getPlan(req.user.plan).checklist ? 'paid' : 'free',
    year: String(new Date().getFullYear()),
    manualMaxLinks: config.scans.manualMaxLinks.toLocaleString('en-US'),
    ...(page.vars ? page.vars(req) : {}),
  };
  const nav = NAV.filter(([, , , needsUser]) => !needsUser || req.user)
    .map(([id, href, label]) => `<a href="${href}"${page.nav === id ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const userbar = req.user
    ? `<span class="who" title="Signed in">${esc(req.user.email)}</span><span class="plan-chip">${esc(getPlan(req.user.plan).name)}</span><a href="/account">Account</a><button type="button" class="linkish" data-logout>Log out</button>`
    : '<span class="who">Guest</span><a href="/login">Log in</a><a class="btn btn-small" href="/signup">Create account</a>';
  const fill = (t) => t
    .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => fill(tpl(`partials/${name}.html`)))
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  let content = fill(tpl(`pages/${page.view}.html`));
  const html = tpl('layout.html')
    .replace('{{content}}', () => content)
    .replace('{{nav}}', nav)
    .replace('{{userbar}}', userbar)
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  content = null;
  res.status(status).type('html').send(html);
}

for (const [route, page] of Object.entries(PAGES)) {
  app.get(route, (req, res) => {
    if (page.auth && !req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    render(req, res, page);
  });
}

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /report/\nDisallow: /api/\n'));
app.use(express.static(path.join(config.root, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }));

app.use((req, res) => render(req, res, { view: '404', title: 'Page not found', nav: '' }, 404));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(err);
  if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Something went wrong on our side.' });
  res.status(500).send('Something went wrong on our side.');
});

const server = app.listen(config.port, config.host, () => {
  console.log(`LinkLantern running at ${config.baseUrl} (listening on ${config.host}:${config.port})`);
  console.log(`  crawler user-agent: ${config.crawler.userAgent}`);
  console.log(`  email: ${mailer.configured ? 'SMTP' : `no SMTP_URL set - emails are saved in ${path.relative(config.root, store.outboxDir)}/`}`);
  if (config.crawler.allowPrivateNetworks) console.log('  WARNING: ALLOW_PRIVATE_NETWORKS is on - the crawler may reach local/internal addresses.');
});

function shutdown() {
  console.log('Shutting down…');
  for (const e of scans.live.values()) e.crawler.stop();
  scheduler.stop();
  setTimeout(() => { store.flush(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }, 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, store, scans };
