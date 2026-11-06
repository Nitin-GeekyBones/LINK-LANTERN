// Password hashing (scrypt), signed session cookies and auth middleware.
// Sessions are stateless HMAC-signed cookies; bumping user.sessionVersion
// (on password change / "log out everywhere") invalidates all existing cookies.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'll_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function createAuth({ store, config }) {
  const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

  function issue(res, user) {
    const expires = Date.now() + config.sessionDays * 86400000;
    const payload = `${user.id}.${user.sessionVersion}.${expires}`;
    const value = `${payload}.${sign(payload)}`;
    res.cookie(COOKIE, value, {
      httpOnly: true, sameSite: 'lax', secure: config.secureCookies,
      expires: new Date(expires), path: '/',
    });
  }

  function clear(res) {
    res.clearCookie(COOKIE, { path: '/' });
  }

  function readUser(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 4) return null;
    const [id, ver, exp, sig] = parts;
    const payload = `${id}.${ver}.${exp}`;
    const good = sign(payload);
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    if (Number(exp) < Date.now()) return null;
    const user = store.getUser(id);
    if (!user || String(user.sessionVersion) !== ver) return null;
    return user;
  }

  // Attaches req.user (or null) to every request.
  function middleware(req, _res, next) {
    req.user = readUser(req);
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Please log in to use this feature.' });
    next();
  }

  return { issue, clear, middleware, requireUser };
}

// Public projection of a user record (never expose password hash).
export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, plan: u.plan, billingCycle: u.billingCycle, createdAt: u.createdAt, slackConfigured: !!u.slackWebhookUrl };
}
