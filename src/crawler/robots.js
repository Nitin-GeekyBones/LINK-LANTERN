// robots.txt parsing and matching, following RFC 9309:
//  * groups are selected by the most specific matching user-agent token
//    (our token, e.g. "linklantern", or else "*"); multiple groups for the same
//    token are merged
//  * Allow / Disallow with "*" wildcards and "$" end anchors; the longest
//    matching rule wins, and Allow wins a tie
//  * Crawl-delay is honoured (non-standard but widely used)
//  * 4xx -> everything allowed; 5xx -> everything disallowed (the server is up
//    but erroring, so the RFC's "unreachable" rule applies)
//  * connection-level failures (DNS, refused, TLS, timeout...) -> allowed: the
//    request for the URL itself fails the same way and reports the precise
//    error instead of a misleading "excluded by robots.txt"

function escapeRegex(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

function compilePattern(path) {
  let anchored = false;
  let p = path;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const re = p.split('*').map(escapeRegex).join('.*');
  return new RegExp(`^${re}${anchored ? '$' : ''}`);
}

function normalizePath(p) {
  // decode percent-encoded unreserved chars so /a%62c matches /abc
  try { return p.replace(/%[0-9a-fA-F]{2}/g, (m) => {
    const c = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
  }); } catch { return p; }
}

export class Robots {
  constructor({ rules = [], crawlDelay = null, allowAll = false, disallowAll = false, reason = '' } = {}) {
    this.rules = rules;           // [{ allow: bool, path: string, re: RegExp }]
    this.crawlDelay = crawlDelay; // seconds or null
    this.allowAll = allowAll;
    this.disallowAll = disallowAll;
    this.reason = reason;
  }

  static allowEverything(reason = '') { return new Robots({ allowAll: true, reason }); }
  static disallowEverything(reason = '') { return new Robots({ disallowAll: true, reason }); }

  static parse(text, agentToken) {
    const token = agentToken.toLowerCase();
    const groups = []; // { agents: [], rules: [], crawlDelay }
    let current = null;
    let lastWasAgent = false;
    for (const rawLine of String(text).split(/\r?\n|\r/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      if (key === 'user-agent') {
        if (!current || !lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!current) continue; // rules before any user-agent line are ignored
      if (key === 'allow' || key === 'disallow') {
        if (key === 'disallow' && value === '') continue; // empty disallow == allow all
        const path = normalizePath(value.startsWith('/') || value.startsWith('*') ? value : `/${value}`);
        current.rules.push({ allow: key === 'allow', path, re: compilePattern(path) });
      } else if (key === 'crawl-delay') {
        const n = parseFloat(value);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      }
    }

    // RFC 9309: match agent by product token (case-insensitive, prefix of UA product)
    const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a.split('/')[0])));
    const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
    const rules = chosen.flatMap((g) => g.rules);
    const delays = chosen.map((g) => g.crawlDelay).filter((d) => d !== null);
    return new Robots({ rules, crawlDelay: delays.length ? Math.max(...delays) : null });
  }

  isAllowed(pathWithQuery) {
    if (this.allowAll) return true;
    if (this.disallowAll) return false;
    const p = normalizePath(pathWithQuery || '/');
    if (p === '/robots.txt') return true;
    let best = null;
    for (const r of this.rules) {
      if (!r.re.test(p)) continue;
      const len = r.path.length;
      if (!best || len > best.path.length || (len === best.path.length && r.allow && !best.allow)) best = r;
    }
    return best ? best.allow : true;
  }
}

/**
 * Fetch and parse robots.txt for an origin using the crawler's HTTP client.
 */
export async function fetchRobots(http, origin, { agentToken, timeoutMs = 10000, signal } = {}) {
  const r = await http.request(`${origin}/robots.txt`, { method: 'GET', wantBody: 'any', timeoutMs, signal });
  if (r.error) return Robots.allowEverything(`robots.txt not fetched (${r.errorLabel})`);
  if (r.status >= 500) return Robots.disallowEverything(`robots.txt returned ${r.status}`);
  if (r.status >= 400) return Robots.allowEverything(`robots.txt returned ${r.status}`);
  return Robots.parse(String(r.body || '').slice(0, 512 * 1024), agentToken);
}
