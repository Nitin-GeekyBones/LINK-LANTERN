// Central configuration. Every value can be overridden with an environment
// variable (or a .env file in the project root, loaded automatically).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file - fine */ }

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

const port = int(env.PORT, 3000);
const host = env.HOST || '127.0.0.1';
const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Session secret: from env, otherwise generated once and persisted in the data dir.
function loadSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(dataDir, '.session-secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const userAgentToken = 'LinkLantern';

export const config = {
  root: ROOT,
  port,
  host,
  baseUrl,
  dataDir,
  sessionSecret: loadSecret(),
  sessionDays: int(env.SESSION_DAYS, 14),
  secureCookies: bool(env.SECURE_COOKIES, baseUrl.startsWith('https://')),
  trustProxy: bool(env.TRUST_PROXY, false),

  captchaEnabled: bool(env.CAPTCHA_ENABLED, true),
  // Billing: "demo" lets users switch plans instantly with no payment (local use).
  // "disabled" hides the switch entirely. Real billing is an integration point (see README).
  billingMode: env.BILLING_MODE || 'demo',

  mail: {
    smtpUrl: env.SMTP_URL || '',            // e.g. smtps://user:pass@smtp.example.com:465
    from: env.MAIL_FROM || 'LinkLantern <reports@linklantern.local>',
  },

  scans: {
    maxConcurrent: int(env.MAX_CONCURRENT_SCANS, 4),   // whole server
    guestConcurrent: 1,                                 // per IP address
    userConcurrent: int(env.USER_CONCURRENT_SCANS, 2),  // per account
    guestReportTtlDays: int(env.GUEST_REPORT_TTL_DAYS, 7),
    manualMaxLinks: int(env.MANUAL_MAX_LINKS, 2000),    // site check & multi check cap
    manualMaxPages: int(env.MANUAL_MAX_PAGES, 500),
    autoMaxLinksPerScan: int(env.AUTO_MAX_LINKS_PER_SCAN, 100000),
    autoMaxPages: int(env.AUTO_MAX_PAGES, 10000),
    multiMaxSites: int(env.MULTI_MAX_SITES, 20),
    guestScansPerHour: int(env.GUEST_SCANS_PER_HOUR, 10),
  },

  crawler: {
    userAgentToken,
    userAgent: env.CRAWLER_USER_AGENT || `${userAgentToken}/1.0 (+${baseUrl}/about#crawler)`,
    allowPrivateNetworks: bool(env.ALLOW_PRIVATE_NETWORKS, false),
    respectRobots: true,              // always on; not user-configurable by design
    concurrency: int(env.CRAWLER_CONCURRENCY, 6),        // simultaneous requests per scan
    perHostConcurrency: int(env.CRAWLER_PER_HOST, 2),    // simultaneous requests per host
    minHostIntervalMs: int(env.CRAWLER_MIN_INTERVAL_MS, 250),
    maxCrawlDelayMs: int(env.CRAWLER_MAX_CRAWL_DELAY_MS, 30000),
    timeoutMs: int(env.CRAWLER_TIMEOUT_MS, 15000),
    maxTimeoutMs: 60000,
    maxRedirects: 10,
    maxBodyBytes: int(env.CRAWLER_MAX_BODY_BYTES, 5 * 1024 * 1024),
    retries: 1,
    maxRetryAfterMs: 30000,
    defaultDepth: 10,
    maxDepth: 20,
    maxOccurrencesPerLink: 50,
  },
};
