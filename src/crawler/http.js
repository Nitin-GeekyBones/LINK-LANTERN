// HTTP client used by the crawler.
//
//  * Follows redirects manually so every hop (URL + status) is recorded.
//  * Detects redirect loops and over-long chains.
//  * Keeps a per-chain, per-host cookie jar so cookie-dependent redirects
//    don't show up as false "redirect loops".
//  * Refuses to connect to private / loopback / link-local addresses unless
//    ALLOW_PRIVATE_NETWORKS is set (SSRF protection). The check runs inside
//    the DNS lookup used for the actual connection, so it also covers redirects
//    and DNS-rebinding tricks.
//  * Hard timeout per request (headers + body) and a cap on body size.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch } from 'undici';
import { describeError } from './statusCodes.js';

// ---------- private address detection ----------
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true; // not an IP at all: treat as unsafe
}

function makeGuardedLookup(allowPrivate) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate) {
        const bad = addresses.find((a) => isPrivateAddress(a.address));
        if (bad) {
          const e = new Error(`Refusing to connect to private address ${bad.address}`);
          e.code = 'EBLOCKED';
          return callback(e);
        }
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TEXT_TYPES = /(text\/html|application\/xhtml\+xml|text\/css)/i;

function charsetOf(contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  return m ? m[1] : 'utf-8';
}

async function readBody(res, maxBytes) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { truncated = true; chunks.push(value.subarray(0, value.byteLength - (size - maxBytes))); break; }
    chunks.push(value);
  }
  if (truncated) { try { await reader.cancel(); } catch { /* ignore */ } }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const ct = res.headers.get('content-type');
  let text;
  try { text = new TextDecoder(charsetOf(ct)).decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); }
  return { text, truncated };
}

export function createHttpClient({ userAgent, allowPrivateNetworks = false, maxBodyBytes = 5 * 1024 * 1024, maxRedirects = 10 }) {
  const agent = new Agent({
    connect: { lookup: makeGuardedLookup(allowPrivateNetworks), timeout: 10000 },
    connections: 16,
    keepAliveTimeout: 4000,
    keepAliveMaxTimeout: 10000,
  });

  async function hop(url, { method, timeoutMs, wantBody, signal, cookie }) {
    const u = new URL(url);
    const bareHost = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivateNetworks && net.isIP(bareHost) && isPrivateAddress(bareHost)) {
      return { error: 'BLOCKED', errorLabel: describeError('BLOCKED'), timeMs: 0 };
    }
    const started = Date.now();
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const headers = {
      'user-agent': userAgent,
      accept: wantBody ? 'text/html,application/xhtml+xml,text/css;q=0.9,*/*;q=0.8' : '*/*',
      'accept-language': 'en;q=0.9,*;q=0.5',
    };
    if (cookie) headers.cookie = cookie;
    try {
      const res = await fetch(url, {
        method, redirect: 'manual', dispatcher: agent, headers, signal: AbortSignal.any(signals),
      });
      const contentType = res.headers.get('content-type') || '';
      let body = null;
      let truncated = false;
      // wantBody: true  -> read HTML/CSS bodies only; 'any' -> read any content type (robots.txt)
      const readable = wantBody === 'any' || TEXT_TYPES.test(contentType);
      if (wantBody && readable && res.status >= 200 && res.status < 300 && method !== 'HEAD') {
        ({ text: body, truncated } = await readBody(res, maxBodyBytes));
      } else if (res.body) {
        try { await res.body.cancel(); } catch { /* ignore */ }
      }
      return {
        status: res.status, statusText: res.statusText, headers: res.headers,
        contentType, body, truncated, timeMs: Date.now() - started,
      };
    } catch (err) {
      if (signal?.aborted) return { error: 'STOPPED', errorLabel: 'Scan stopped', timeMs: Date.now() - started };
      const code = classifyError(err);
      return { error: code, errorLabel: describeError(code, err), timeMs: Date.now() - started };
    }
  }

  /**
   * Request a URL, following redirects manually.
   * Returns { status, statusText, error, errorLabel, redirects: [{url, status}], finalUrl,
   *           contentType, body, truncated, timeMs, retryAfter }
   */
  async function request(url, { method = 'GET', timeoutMs = 15000, wantBody = false, signal } = {}) {
    const redirects = [];
    const jar = new Map(); // host -> Map(name -> value)
    const cookieFor = (u) => {
      const m = jar.get(new URL(u).host);
      return m && m.size ? [...m].map(([k, v]) => `${k}=${v}`).join('; ') : '';
    };
    // A URL may legitimately be revisited if the cookies sent with it changed
    // (e.g. "set a cookie and redirect to yourself"), so loops are detected on
    // (url, cookies) pairs.
    const seen = new Set([`${url}\n`]);
    let current = url;
    let verb = method;
    let totalMs = 0;
    for (;;) {
      const host = new URL(current).host;
      const r = await hop(current, { method: verb, timeoutMs, wantBody, signal, cookie: cookieFor(current) || undefined });
      totalMs += r.timeMs;
      if (r.error) return { ...r, redirects, finalUrl: current, timeMs: totalMs };

      if (REDIRECT_STATUSES.has(r.status)) {
        const loc = r.headers.get('location');
        if (!loc) {
          return { ...r, error: 'NO_LOCATION', errorLabel: describeError('NO_LOCATION'), redirects, finalUrl: current, timeMs: totalMs };
        }
        // remember cookies set by this hop, scoped to its host
        const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
        if (setCookies.length) {
          const m = jar.get(host) || new Map();
          for (const sc of setCookies) {
            const pair = sc.split(';', 1)[0];
            const i = pair.indexOf('=');
            if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
          }
          jar.set(host, m);
        }
        let next;
        try {
          const nu = new URL(loc, current);
          nu.hash = '';
          next = nu.href;
        } catch {
          return { ...r, error: 'BAD_REDIRECT', errorLabel: describeError('BAD_REDIRECT'), redirects, finalUrl: current, timeMs: totalMs };
        }
        redirects.push({ url: current, status: r.status, location: next });
        if (!/^https?:$/.test(new URL(next).protocol)) {
          return { status: r.status, error: 'UNSUPPORTED', errorLabel: describeError('UNSUPPORTED'), redirects, finalUrl: next, timeMs: totalMs };
        }
        const visitKey = `${next}\n${cookieFor(next)}`;
        if (seen.has(visitKey)) {
          return { status: r.status, error: 'REDIRECT_LOOP', errorLabel: describeError('REDIRECT_LOOP'), redirects, finalUrl: next, timeMs: totalMs };
        }
        if (redirects.length >= maxRedirects) {
          return { status: r.status, error: 'TOO_MANY_REDIRECTS', errorLabel: describeError('TOO_MANY_REDIRECTS'), redirects, finalUrl: next, timeMs: totalMs };
        }
        seen.add(visitKey);
        if (r.status === 303 && verb !== 'HEAD') verb = 'GET';
        current = next;
        continue;
      }

      return {
        status: r.status, statusText: r.statusText, contentType: r.contentType,
        body: r.body, truncated: r.truncated, redirects, finalUrl: current, timeMs: totalMs,
        retryAfter: r.headers.get('retry-after'),
      };
    }
  }

  return { request, close: () => agent.close() };
}

export function classifyError(err) {
  if (!err) return 'NETWORK';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'TIMEOUT';
  // undici wraps the real error in err.cause (sometimes nested)
  let e = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = e.code;
    if (code) {
      if (code === 'EBLOCKED') return 'BLOCKED';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_FAIL') return 'DNS';
      if (code === 'ECONNREFUSED') return 'REFUSED';
      if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE' || code === 'UND_ERR_CLOSED') return 'RESET';
      if (/TIMEOUT/i.test(code) || code === 'ETIMEDOUT') return 'TIMEOUT';
      if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'UNREACHABLE';
      if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return 'TLS';
      if (code === 'UND_ERR_INVALID_ARG' || code === 'ERR_INVALID_URL') return 'INVALID_URL';
    }
    if (e.name === 'TimeoutError') return 'TIMEOUT';
    e = e.cause;
  }
  return 'NETWORK';
}
