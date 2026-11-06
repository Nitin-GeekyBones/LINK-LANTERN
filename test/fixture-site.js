// A small local website full of deliberately broken links, used by the test
// suite and handy for trying LinkLantern locally:
//
//   npm run fixture            -> http://localhost:4010
//   ALLOW_PRIVATE_NETWORKS=true npm start, then check localhost:4010
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const page = (title, body) => `<!doctype html><html><head><title>${title}</title>
<link rel="stylesheet" href="/style.css"><link rel="preconnect" href="https://fonts.example.invalid"></head>
<body>${body}</body></html>`;

export function createFixtureServer() {
  const rateHits = new Map();
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (status, body = '', headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const redirect = (status, to, headers = {}) => send(status, '', { location: to, ...headers });

    switch (p) {
      case '/robots.txt':
        return send(200, 'User-agent: *\nDisallow: /private/\nAllow: /private/ok.html\n', { 'content-type': 'text/plain' });
      case '/':
        return send(200, page('Home', `
          <h1>Fixture home</h1>
          <a href="/about">About us</a>
          <a href="/missing">A missing page</a>
          <a href="/gone">Gone page</a>
          <a href="/old">Old address</a>
          <a href="/loop-a">Loop</a>
          <a href="/chain">Chain</a>
          <a href="/slow">Slow page</a>
          <a href="/error">Server error</a>
          <a href="/private/secret.html">Private</a>
          <a href="/private/ok.html">Private but allowed</a>
          <a href="/nofollow-page" rel="nofollow">Nofollow</a>
          <a href="/head-405">HEAD refused</a>
          <a href="/rate">Rate limited</a>
          <a href="/cookie-redirect">Cookie redirect</a>
          <a href="/deep/1">Deep</a>
          <a href="http://does-not-exist.invalid/">Dead external host</a>
          <a href="mailto:hello@example.com">Email</a>
          <a href="#top">Top</a>
          <a href="/bad\\path">Backslash</a>
          <a href="/sub/"><img src="/img/logo.png" alt="Sub section"></a>
          <img src="/img/missing.png" alt="Missing image" srcset="/img/logo.png 1x, /img/missing-2x.png 2x">
          <div style="background:url('/img/inline-missing.png')"></div>
          <form action="/search" method="get"><input name="q"></form>
          <form action="/post-only" method="post"></form>
          <a href="/about#team">About (team)</a>`));
      case '/about':
        return send(200, page('About', '<a href="/">Home</a> <a href="/page?x=1">Page 1</a> <a href="/page?x=2">Page 2</a> <a href="/missing">Missing again</a>'));
      case '/page':
        return url.searchParams.get('x') === '2' ? send(404, 'nope') : send(200, page('Page', 'ok'));
      case '/missing': return send(404, page('Not found', 'Not found'));
      case '/gone': return send(410, page('Gone', 'Gone'));
      case '/old': return redirect(301, '/about');
      case '/loop-a': return redirect(302, '/loop-b');
      case '/loop-b': return redirect(302, '/loop-a');
      case '/chain': return redirect(302, '/chain2');
      case '/chain2': return redirect(301, '/about');
      case '/slow': { const t = setTimeout(() => send(200, 'finally'), 20000); req.on('close', () => clearTimeout(t)); return undefined; }
      case '/error': return send(500, 'boom');
      case '/private/secret.html': return send(200, 'secret');
      case '/private/ok.html': return send(200, page('ok', 'ok'));
      case '/nofollow-page': return send(200, page('NF', '<a href="/only-from-nofollow">hidden</a>'));
      case '/only-from-nofollow': return send(200, 'should not be discovered');
      case '/head-405': return req.method === 'HEAD' ? send(405, '') : send(200, page('ok', 'ok'));
      case '/rate': {
        const n = (rateHits.get('r') || 0) + 1;
        rateHits.set('r', n);
        return n === 1 ? send(429, 'slow down', { 'retry-after': '1' }) : send(200, page('ok', 'ok'));
      }
      case '/cookie-redirect':
        if (/visited=1/.test(req.headers.cookie || '')) return send(200, page('ok', 'ok'));
        return redirect(302, '/cookie-redirect', { 'set-cookie': 'visited=1; Path=/' });
      case '/sub/': return send(200, page('Sub', '<a href="../">Up</a> <a href="/sub/child">Child</a>'));
      case '/sub/child': return send(200, page('Child', 'leaf'));
      case '/search': return send(200, page('Search', 'results'));
      // pages for CAPTCHA detection and the content checklist (not linked from the home page)
      case '/contact': return send(200, page('Contact', `
          <script src="https://www.google.com/recaptcha/api.js" async defer></script>
          <h1>Contact us</h1>
          <p>Call +1 (415) 555-0132 or write to hello@fixture.example. Prices from $1,299.00.</p>
          <p>Lorem ipsum dolor sit amet. Published 2024-05-01, order 12345.</p>
          <a href="mailto:sales@fixture.example">Sales</a> <a href="/sub/">Old Brand Name</a>
          <form><div class="g-recaptcha" data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></div></form>
          <footer>© 2019 Old Brand Name. oldbrand</footer>`));
      case '/signup-v3': return send(200, page('Signup', `
          <script src="https://www.google.com/recaptcha/api.js?render=6LdCrawlerTestSiteKeyAbcdefghijklmno"></script>
          <script>grecaptcha.ready(() => grecaptcha.execute('6LdCrawlerTestSiteKeyAbcdefghijklmno', { action: 'signup' }));</script>
          <p>No contact details here.</p>`));
      case '/style.css':
        return send(200, 'body{background:url(/img/bg-missing.png)} .x{background:url("/img/logo.png")}', { 'content-type': 'text/css' });
      case '/img/logo.png':
        return send(200, 'PNG', { 'content-type': 'image/png' });
      default:
        if (p.startsWith('/deep/')) {
          const n = Number(p.split('/')[2]);
          return send(200, page(`Deep ${n}`, `<a href="/deep/${n + 1}">Deeper</a>`));
        }
        return send(404, 'Not found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FIXTURE_PORT || 4010);
  createFixtureServer().listen(port, () => console.log(`Fixture site with broken links at http://localhost:${port}/`));
}
