// Per-host politeness: caps simultaneous requests to one host and enforces a
// minimum gap between request starts (raised by robots.txt Crawl-delay and by
// 429 responses, which double the gap - adaptive back-off).
export const sleep = (ms, signal) => new Promise((resolve) => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

export class HostThrottle {
  constructor({ perHost = 2, minIntervalMs = 250, maxIntervalMs = 30000 } = {}) {
    this.perHost = perHost;
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.hosts = new Map();
  }

  _get(host) {
    let h = this.hosts.get(host);
    if (!h) {
      h = { active: 0, waiters: [], nextAllowed: 0, interval: this.minIntervalMs, max: this.perHost };
      this.hosts.set(host, h);
    }
    return h;
  }

  /** Apply a robots.txt crawl-delay (seconds). Serialises requests to that host. */
  setCrawlDelay(host, seconds) {
    const h = this._get(host);
    h.interval = Math.min(Math.max(h.interval, seconds * 1000), this.maxIntervalMs);
    h.max = 1;
  }

  /** Apply a user-requested interval (ms) to a host. */
  setInterval(host, ms) {
    const h = this._get(host);
    h.interval = Math.min(Math.max(h.interval, ms), this.maxIntervalMs);
    if (ms >= 1000) h.max = 1;
  }

  /** Called after a 429 / 503: halve the request rate for this host. */
  slowDown(host) {
    const h = this._get(host);
    h.interval = Math.min(Math.max(h.interval * 2, 1000), this.maxIntervalMs);
    h.max = 1;
  }

  interval(host) { return this._get(host).interval; }

  async acquire(host, signal) {
    const h = this._get(host);
    while (h.active >= h.max) {
      if (signal?.aborted) break;
      await new Promise((r) => h.waiters.push(r));
    }
    h.active++;
    const now = Date.now();
    const wait = Math.max(0, h.nextAllowed - now);
    h.nextAllowed = Math.max(now, h.nextAllowed) + h.interval;
    if (wait) await sleep(wait, signal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      h.active--;
      const w = h.waiters.shift();
      if (w) w();
    };
  }

  /** Wake everyone (used when a scan is stopped). */
  releaseAll() {
    for (const h of this.hosts.values()) { const ws = h.waiters; h.waiters = []; ws.forEach((w) => w()); }
  }
}
