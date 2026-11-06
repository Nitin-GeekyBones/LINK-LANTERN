// A small, dependency-free JSON file store.
//
//   data/db.json            users, schedules, batches, report index, usage, reset tokens
//   data/reports/<id>.json  full report (including every checked link)
//
// Writes are atomic (write temp file, then rename) and debounced. This is ample
// for a single-process deployment; swap this module for a SQL store if you need
// several app servers sharing state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY_DB = () => ({
  version: 1,
  users: [],
  reports: [],      // index entries (no link data)
  schedules: [],
  batches: [],
  usage: {},        // userId -> { month: 'YYYY-MM', links: number }
  resetTokens: [],  // { tokenHash, userId, expires }
});

export const newId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.reportsDir = path.join(dir, 'reports');
    this.outboxDir = path.join(dir, 'outbox');
    fs.mkdirSync(this.reportsDir, { recursive: true });
    fs.mkdirSync(this.outboxDir, { recursive: true });
    this.dbFile = path.join(dir, 'db.json');
    this.db = EMPTY_DB();
    if (fs.existsSync(this.dbFile)) {
      this.db = { ...EMPTY_DB(), ...JSON.parse(fs.readFileSync(this.dbFile, 'utf8')) };
    }
    this._timer = null;
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 150);
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    atomicWrite(this.dbFile, JSON.stringify(this.db, null, 1));
  }

  // ---------- users ----------
  createUser({ email, passwordHash }) {
    const user = {
      id: newId(9), email: email.toLowerCase(), passwordHash,
      plan: 'free', billingCycle: 'monthly', sessionVersion: 1,
      createdAt: new Date().toISOString(),
    };
    this.db.users.push(user);
    this.save();
    return user;
  }
  getUser(id) { return this.db.users.find((u) => u.id === id) || null; }
  getUserByEmail(email) {
    const e = String(email || '').toLowerCase();
    return this.db.users.find((u) => u.email === e) || null;
  }
  updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) return null;
    Object.assign(u, patch);
    this.save();
    return u;
  }
  deleteUser(id) {
    for (const r of this.listReports(id)) this.deleteReport(r.id);
    this.db.users = this.db.users.filter((u) => u.id !== id);
    this.db.schedules = this.db.schedules.filter((s) => s.owner !== id);
    this.db.batches = this.db.batches.filter((b) => b.owner !== id);
    delete this.db.usage[id];
    this.save();
  }

  // ---------- usage (links checked per calendar month) ----------
  static month(d = new Date()) { return d.toISOString().slice(0, 7); }
  getUsage(userId) {
    const m = Store.month();
    const u = this.db.usage[userId];
    return u && u.month === m ? u.links : 0;
  }
  addUsage(userId, links) {
    const m = Store.month();
    const u = this.db.usage[userId];
    if (!u || u.month !== m) this.db.usage[userId] = { month: m, links: 0 };
    this.db.usage[userId].links += links;
    this.save();
  }

  // ---------- password reset tokens ----------
  addResetToken(userId) {
    const token = newId(24);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    this.db.resetTokens = this.db.resetTokens.filter((t) => t.userId !== userId && t.expires > Date.now());
    this.db.resetTokens.push({ tokenHash, userId, expires: Date.now() + 60 * 60 * 1000 });
    this.save();
    return token;
  }
  consumeResetToken(token) {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const t = this.db.resetTokens.find((x) => x.tokenHash === tokenHash && x.expires > Date.now());
    this.db.resetTokens = this.db.resetTokens.filter((x) => x !== t);
    this.save();
    return t ? t.userId : null;
  }

  // ---------- reports ----------
  static indexEntry(r) {
    const { links, captcha, matches, ...meta } = r; // eslint-disable-line no-unused-vars
    return meta;
  }
  saveReport(report) {
    atomicWrite(path.join(this.reportsDir, `${report.id}.json`), JSON.stringify(report));
    this.upsertReportIndex(report);
  }
  upsertReportIndex(report) {
    const entry = Store.indexEntry(report);
    const i = this.db.reports.findIndex((r) => r.id === report.id);
    if (i >= 0) this.db.reports[i] = entry; else this.db.reports.push(entry);
    this.save();
  }
  getReportMeta(id) { return this.db.reports.find((r) => r.id === id) || null; }
  loadReport(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.reportsDir, `${id}.json`), 'utf8')); } catch { return null; }
  }
  listReports(owner) {
    return this.db.reports.filter((r) => r.owner === owner)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  deleteReport(id) {
    this.db.reports = this.db.reports.filter((r) => r.id !== id);
    try { fs.unlinkSync(path.join(this.reportsDir, `${id}.json`)); } catch { /* already gone */ }
    this.save();
  }
  purgeGuestReports(ttlDays) {
    const cutoff = Date.now() - ttlDays * 86400000;
    const old = this.db.reports.filter((r) => !r.owner && Date.parse(r.createdAt) < cutoff);
    for (const r of old) this.deleteReport(r.id);
    return old.length;
  }

  // ---------- schedules (auto check) ----------
  listSchedules(owner) { return this.db.schedules.filter((s) => s.owner === owner); }
  allSchedules() { return this.db.schedules; }
  getSchedule(id) { return this.db.schedules.find((s) => s.id === id) || null; }
  addSchedule(s) { this.db.schedules.push(s); this.save(); return s; }
  updateSchedule(id, patch) {
    const s = this.getSchedule(id);
    if (!s) return null;
    Object.assign(s, patch);
    this.save();
    return s;
  }
  deleteSchedule(id) { this.db.schedules = this.db.schedules.filter((s) => s.id !== id); this.save(); }

  // ---------- batches (multi check) ----------
  addBatch(b) { this.db.batches.push(b); this.save(); return b; }
  getBatch(id) { return this.db.batches.find((b) => b.id === id) || null; }
  listBatches(owner) {
    return this.db.batches.filter((b) => b.owner === owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  updateBatch(id, patch) { const b = this.getBatch(id); if (b) { Object.assign(b, patch); this.save(); } return b; }
}
