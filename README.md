# LinkLantern

A self-hosted broken link checker with a web UI. It reproduces the feature set of the well-known free online dead-link checkers (single-site checks, multi-site batches with emailed reports, scheduled "auto" checks on paid tiers, CSV export) with its own original branding, copy and design.

- **Site check** scans a whole website (up to 10 links deep) or a single page, streaming results live. No account needed; a security code is required for guests.
- **Multi check** queues up to 20 sites, then emails one combined report when the last finishes. Requires a free account.
- **Auto check** runs daily, weekly or monthly schedules with ignore lists, crawl interval, timeout, folder restriction, nofollow override and "don't email if clean". Requires a paid plan (demo billing included).
- **Reports**: live progress over Server-Sent Events, filter by Broken / Redirected / Not checked / All, redirect chains hop by hop, every place a link appears, CSV and JSON downloads.
- **CAPTCHA detection**: every scanned page is checked for Google reCAPTCHA (v2 checkbox, v2 invisible, v3, Enterprise). The report's *CAPTCHA pages* tab lists only pages where one was found, with the variant, site key and how it was spotted.
- **Content checklist** (paid plans): search every scanned page for email addresses, phone numbers, prices, placeholder text, copyright notices and up to 20 words or phrases of your own. Matches appear in a *Text matches* tab with surrounding context.
- **Slack**: connect an Incoming Webhook in Account settings, then tick "Send the report to Slack" on a site check, multi check or schedule.
- **Exports**: links, CAPTCHA pages and text matches each download as CSV (and are attached to report emails); everything is in the JSON export.
- **Accounts**: sign up, log in, password reset by email, change email and password, delete account, plan switching.

## Requirements

- Node.js **20.18 or newer** (tested on 22)
- No database server or native modules. Data lives in JSON files under `data/`.

Dependencies: `express` (HTTP server), `undici` (HTTP client with a custom DNS guard), `cheerio` (HTML parsing), `nodemailer` (email).

## Quick start

```bash
npm install
npm start                      # http://localhost:3000
```

Try it against the bundled test site, which is full of deliberately broken links:

```bash
npm run fixture                                  # terminal 1: http://localhost:4010
ALLOW_PRIVATE_NETWORKS=true npm start            # terminal 2
# open http://localhost:3000 and check  localhost:4010
```

`ALLOW_PRIVATE_NETWORKS` is needed only because the fixture runs on localhost. Leave it off for any server reachable by other people.

Run the tests (crawler behaviour against the fixture, robots.txt parsing, extraction, SSRF guard, CSV escaping):

```bash
npm test
```

## Configuration

Set environment variables, or put them in a `.env` file in the project root (loaded automatically). See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the server listens. Use `HOST=0.0.0.0` to accept outside connections. |
| `BASE_URL` | `http://localhost:PORT` | Public URL, used in emails and the crawler's user-agent. |
| `DATA_DIR` | `./data` | JSON database, reports and email outbox. |
| `SESSION_SECRET` | generated once, stored in `data/.session-secret` | Signs login cookies. |
| `SECURE_COOKIES` | on when `BASE_URL` is https | Marks cookies `Secure`. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so per-IP limits see real client IPs. |
| `SMTP_URL` | *(empty)* | e.g. `smtps://user:pass@smtp.example.com:465`. Without it, emails are written to `data/outbox/*.eml`. |
| `MAIL_FROM` | `LinkLantern <reports@linklantern.local>` | Sender address. |
| `CAPTCHA_ENABLED` | `true` | Security code for guest scans. |
| `BILLING_MODE` | `demo` | `demo` = switch plans instantly for free; `disabled` = hide plan switching. |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Allow the crawler to reach loopback/private/link-local addresses. |
| `MAX_CONCURRENT_SCANS` | `4` | Scans running at once across the server; others queue. |
| `USER_CONCURRENT_SCANS` | `2` | Running scans per account. Guests: 1 per IP address. |
| `GUEST_SCANS_PER_HOUR` | `10` | Guest scan starts per IP per hour. |
| `GUEST_REPORT_TTL_DAYS` | `7` | Guest reports are deleted after this. |
| `MANUAL_MAX_LINKS` / `MANUAL_MAX_PAGES` | `2000` / `500` | Caps for Site check and Multi check. |
| `AUTO_MAX_LINKS_PER_SCAN` / `AUTO_MAX_PAGES` | `100000` / `10000` | Caps per scheduled scan (also bounded by the monthly allowance). |
| `MULTI_MAX_SITES` | `20` | Sites per Multi check batch. |
| `CRAWLER_CONCURRENCY` | `6` | Parallel requests per scan (all hosts). |
| `CRAWLER_PER_HOST` | `2` | Parallel requests per host. |
| `CRAWLER_MIN_INTERVAL_MS` | `250` | Minimum gap between requests to one host. |
| `CRAWLER_MAX_CRAWL_DELAY_MS` | `30000` | Upper bound applied to robots.txt `Crawl-delay`. |
| `CRAWLER_TIMEOUT_MS` | `15000` | Per-request timeout (headers and body). |
| `CRAWLER_MAX_BODY_BYTES` | `5242880` | Largest HTML/CSS body that will be parsed. |
| `CRAWLER_USER_AGENT` | `LinkLantern/1.0 (+BASE_URL/about#crawler)` | Request user-agent. robots.txt rules are matched on the token `LinkLantern`. |

Plans and their limits are defined in `src/plans.js`.

## Project structure

```
linklantern/
├── package.json
├── .env.example
├── src/
│   ├── server.js            Express app: pages, JSON API, CSRF/origin checks, rate limits, security headers
│   ├── config.js            All settings and their env overrides
│   ├── store.js             JSON-file persistence (users, reports, schedules, batches, usage, reset tokens)
│   ├── auth.js              scrypt password hashing, signed session cookies, auth middleware
│   ├── captcha.js           Self-hosted SVG security code for guest scans
│   ├── mailer.js            SMTP delivery, or .eml files in data/outbox
│   ├── plans.js             Plan definitions and limits
│   ├── scanManager.js       Queueing, concurrency limits, SSE streaming, persistence, email notifications
│   ├── scheduler.js         Auto check scheduler (30 s tick, monthly quota checks)
│   ├── reportFormat.js      CSV exports (links, CAPTCHA pages, text matches) and HTML email summaries
│   ├── slack.js             Slack webhook validation, Block Kit report messages, delivery
│   └── crawler/
│       ├── Crawler.js       The scan engine (BFS, depth/page/link limits, scope, retries)
│       ├── http.js          HTTP client: manual redirects, loop detection, cookie jar, SSRF guard, timeouts
│       ├── robots.js        RFC 9309 robots.txt parser and matcher, Crawl-delay
│       ├── extract.js       Link extraction from HTML and CSS
│       ├── detect.js        reCAPTCHA detection and content checklist matching
│       ├── throttle.js      Per-host concurrency and pacing with adaptive back-off
│       └── statusCodes.js   Labels for HTTP statuses and crawler error codes
├── views/
│   ├── layout.html          Shared header, nav and footer
│   ├── partials/checker.html  The URL form used on Home and Site check
│   ├── partials/checklist.html  Content checklist fields (paid plans) used by every scan form
│   └── pages/*.html         One template per page
├── public/
│   ├── css/style.css
│   ├── img/favicon.svg
│   └── js/                  ES modules: main.js (router), common.js, scan-view.js, pages/*.js
└── test/
    ├── fixture-site.js      Local site with every kind of breakage
    ├── crawler.test.js      End-to-end crawler tests against the fixture
    ├── features.test.js     CAPTCHA detection, content checklist, Slack and CSV export tests
    └── robots.test.js       Unit tests
```

## How a scan works

1. **Start page.** The address is normalised. If no scheme was typed, `https://` is tried first, then `http://` on connection-level failures (refused, TLS, timeout, reset). If the start page fails, redirects to a non-HTML resource, or is excluded by robots.txt, the report ends with a clear "couldn't run" message. If it redirects (say `example.com` to `www.example.com`), the landing host becomes the site being scanned.
2. **Discovery.** Every URL found is resolved against the page (honouring `<base href>`), stripped of its `#fragment`, and recorded once along with every place it appears (page, link text or element, attribute). Different query strings are different URLs. `mailto:`, `tel:`, `javascript:`, `data:` and in-page anchors are ignored. URLs containing a backslash are reported as malformed.
3. **Checking.** Same-host pages within the depth limit are fetched with `GET` and parsed for more links. Everything else gets `HEAD`, retried as `GET` if `HEAD` fails with an error status or a dropped connection (many servers mishandle `HEAD`). Same-site stylesheets are fetched and their `url()`/`@import` references checked.
4. **Redirects** are followed manually (up to 10). Each hop is recorded. Loops are detected on (URL, cookies) pairs, and cookies set during a chain are sent back to the same host within that chain, so "set a cookie and redirect to yourself" patterns aren't misreported as loops.
5. **Classification.** `2xx` = OK; `2xx` after redirects = Redirected; `3xx` without a target, `4xx`, `5xx`, or any network failure = Broken; robots.txt exclusions and links left unchecked when a scan is stopped = Not checked (not counted as errors).

### Politeness

- robots.txt is fetched and honoured for **every host**, not just the scanned site. Groups for the `LinkLantern` token take priority over `*`; `Allow`/`Disallow` with `*` and `$` wildcards; longest match wins, `Allow` wins ties. 4xx means everything is allowed; 5xx means the host is off-limits (RFC 9309). If robots.txt can't be fetched at all (DNS failure, refused connection, TLS error), the URL's own request reports that exact error.
- `Crawl-delay` serialises requests to that host at that pace (capped by `CRAWLER_MAX_CRAWL_DELAY_MS`).
- At most `CRAWLER_PER_HOST` requests in flight per host, with `CRAWLER_MIN_INTERVAL_MS` between starts.
- `429` and `503` responses trigger a wait (honouring `Retry-After`, capped at 30 s), one retry, and a permanent halving of the request rate for that host for the rest of the scan. Timeouts and resets get one retry.
- Hard limits on depth, pages parsed and unique links per scan. Bodies over 5 MB are truncated before parsing.
- The crawler identifies itself and explains itself at `/about#crawler`.

### Security

- **SSRF protection.** A custom DNS lookup inside the HTTP agent refuses loopback, private, link-local (including cloud metadata `169.254.169.254`), CGNAT, multicast and reserved ranges, for IPv4 and IPv6. Because the check runs at connection time, it also covers redirects and DNS rebinding. Literal IP URLs are checked too.
- Passwords hashed with scrypt; HMAC-signed `HttpOnly`, `SameSite=Lax` session cookies; changing the password invalidates every other session.
- State-changing API calls must be JSON and, when an `Origin` header is present, same-origin (CSRF defence).
- Strict Content-Security-Policy (no inline scripts), `X-Frame-Options: DENY`, `nosniff`.
- Rate limits on log-in, sign-up, password reset and scan creation; per-IP and per-account concurrency limits.
- CSV export neutralises spreadsheet formula injection.
- Content checklist terms are matched as literal text, never as user-supplied regular expressions, so a hostile pattern can't stall the crawler (ReDoS). Up to 25 distinct matches per rule per page and 5,000 per report are kept.
- Slack webhook URLs must be `https://hooks.slack.com/…` (or `hooks.slack-gov.com`), and redirects are refused, so the webhook can't be pointed at internal addresses. The URL is never sent back to the browser.
- Reports of logged-in users are visible only to their owner. Guest reports are reachable by their unguessable ID only.

## JSON API

All endpoints are under `/api`. Write requests need `Content-Type: application/json`.

| Method & path | Auth | Description |
|---|---|---|
| `GET /meta` | – | Plans, limits, error-code labels, current user. |
| `GET /captcha` | – | `{required, id, image}` for guests. |
| `POST /scans` | – | Start a site check: `{url, mode: "site"\|"page", captchaId, captchaAnswer, emailWhenDone, slack, checklist}`. `checklist` is `{presets: ["email","phone","price","placeholder","copyright"], terms: ["…"], caseSensitive, wholeWord}` and needs a paid plan (402 otherwise); `slack: true` needs a saved webhook. |
| `GET /scans/:id` | owner/guest | Report with `links`, `captcha` and `matches` (`?links=0` for summary only). Works while running. |
| `GET /scans/:id/events` | owner/guest | SSE stream: `snapshot`, `queued`, `progress`, `link` (problems only), `captcha`, `matches`, `done`. |
| `POST /scans/:id/stop` | owner/guest | Stop a queued or running scan; partial results are kept. |
| `GET /scans/:id/export.csv` | owner/guest | CSV, one row per occurrence (`?only=problems` to skip OK links). `?section=captcha` for CAPTCHA pages, `?section=matches` for content checklist matches. |
| `GET /scans/:id/export.json` | owner/guest | Full report JSON. |
| `GET /scans/active` | user | Your running scans. |
| `GET /reports`, `DELETE /reports/:id` | user | Your saved reports. |
| `POST /multi`, `GET /multi` | user | Start a batch `{urls: "a\nb", mode, slack, checklist}`; list batches. Slack gets one combined message per batch. |
| `GET/POST /schedules`, `PUT/DELETE /schedules/:id`, `POST /schedules/:id/run` | user + paid plan | Auto check schedules. Body fields: `url, frequency, nextRun ("now" or ISO), depth, ignore, intervalMs, timeoutMs, restrictToDir, overrideNofollow, suppressEmptyEmail, active, notifySlack, checklist`. |
| `POST /auth/signup`, `/auth/login`, `/auth/logout`, `/auth/forgot`, `/auth/reset` | – | Accounts. |
| `GET /me`, `PUT /account/email`, `PUT /account/password`, `POST /account/plan`, `DELETE /account` | user | Account settings. |
| `PUT /account/slack`, `POST /account/slack/test` | user | Save (`{webhookUrl}`; empty string removes it) or test the Slack webhook. |

## Behaviour decisions (where the reference was ambiguous)

These choices were made deliberately and are applied consistently:

1. **Depth.** Whole-site checks go 10 levels deep (start page = 0). A page at the depth limit has its links *checked*, but those targets aren't opened. Single-page mode is depth 0. Auto check depth is configurable from 0 to 20.
2. **Site scope.** Only the exact host of the (post-redirect) start URL is crawled; `http` and `https` on that host count as the same site; other subdomains are external. Folder restriction is an Auto check option, matching the reference.
3. **Free caps.** 2,000 unique links and 500 parsed pages per manual check, on every plan, as the reference keeps its interactive tools capped for subscribers too.
4. **Captcha.** Guests solve a code per scan; logged-in users don't.
5. **Concurrency.** One active scan per guest IP; two running per account (more queue). Multi check sites queue and run two at a time.
6. **robots.txt for external hosts** is honoured too (the reference only documents the scanned site). Excluded URLs show as *Not checked*, not as errors.
7. **nofollow** links and pages are checked but not explored, in all modes; the override is an Auto check option. (The reference applies nofollow only in Auto check.)
8. **Cookies** are not shared between pages, but are kept within one redirect chain to avoid false loops. (The reference propagates none in Site/Multi check.)
9. **Persistent 429** after the retry is reported as broken; the FAQ explains why such links may still work in a browser.
10. **POST forms** are never probed (checking a form action could submit data). GET form actions are checked.
11. **Guest reports** are kept 7 days; account reports until deleted.
12. **Email.** Multi check sends one combined email per batch; Auto check sends one per run (unless "don't email if clean" and nothing is broken); Site check emails only if the logged-in user ticks the box. Emails attach a problems-only CSV.
13. **Monthly allowance** is counted in links checked by all of a user's scans, and enforced for scheduled scans (each run is capped at the remaining allowance). It resets on the 1st, UTC.
14. **Scheme pinning.** A schedule created without `http(s)://` falls back like a site check, then remembers the working scheme after its first successful run.
15. **Pricing.** Three paid tiers with the same structure as the reference (5 / 100 / 200 sites; 50k / 500k / 1M links a month) but LinkLantern's own names and prices.

## Assumptions and things that couldn't be verified

The reference site's public pages, FAQ, features list, error-code guide and pricing pages were studied. Behind-login screens and actual scan output couldn't be observed directly, so these parts are reconstructed from the documentation:

- **Exact results layout.** The reference's results table columns are Status, URL and source link text; LinkLantern adds the source page, redirect chain and occurrence list, and filter tabs.
- **Auto check screens.** Layout of the schedule editor and the "scans in progress" panel is inferred from the FAQ's description (Add new scan, Now button, frequency, depth, advanced section, end scan, intermediate report).
- **Email verification at sign-up.** The reference emails a link to finish registering. LinkLantern activates accounts immediately and sends a welcome email, so it works without SMTP during local use. Adding a verification step would be a small change in `src/server.js`.
- **Payments.** The reference takes payment through PayPal. LinkLantern ships with `BILLING_MODE=demo`; real billing is an integration point: on a provider webhook (Stripe, Paddle, PayPal), call `store.updateUser(id, { plan, billingCycle })` and set `BILLING_MODE=disabled` so users can't switch plans themselves.
- **Currency selector** (USD/EUR/GBP on the reference) is not implemented; prices are shown in USD.
- **Retry policy and adaptive slow-down.** The reference says it "retries after a pause" and "adjusts its scan rate"; the specific numbers here (1 retry, Retry-After capped at 30 s, halving the rate) are LinkLantern's own.
- **Brotli.** The reference can't decompress Brotli responses; LinkLantern can (gzip, deflate and br are handled by undici).
- **Blog and Resources** sections of the reference are content marketing and were left out.

## Deploying

- Run behind a reverse proxy with TLS; set `BASE_URL=https://…`, `TRUST_PROXY=true`, `HOST=127.0.0.1` and `NODE_ENV=production` (template caching, static asset caching).
- Configure `SMTP_URL` so reports are actually delivered.
- Keep `ALLOW_PRIVATE_NETWORKS=false` on anything public.
- The JSON store suits a single process. To run several instances, replace `src/store.js` with a database-backed implementation of the same methods, and move the scan queue to a shared job queue.
- The built-in security code is a speed bump (its SVG can be read by a determined bot). For a public deployment, swap `src/captcha.js` for Cloudflare Turnstile or hCaptcha; the module exposes just `create()` and `verify()`.

## Originality

LinkLantern's name, logo, copy, layout and visual design are original. The reference site's name, logo, text and images are not used. What is shared is functionality and general interface patterns common to link checkers, plus factual specifications such as the list of HTML attributes that can hold URLs and the standard meanings of HTTP status codes.

## License

MIT
