// Link extraction from HTML and CSS.
import * as cheerio from 'cheerio';
import { detectRecaptcha, pageText, findMatches } from './detect.js';

// [tag, attribute] pairs whose values are URLs that should be verified.
export const URL_ATTRIBUTES = [
  ['a', 'href'], ['area', 'href'], ['applet', 'codebase'], ['audio', 'src'],
  ['blockquote', 'cite'], ['body', 'background'], ['button', 'formaction'], ['command', 'icon'],
  ['del', 'cite'], ['embed', 'src'], ['form', 'action'], ['frame', 'src'], ['frame', 'longdesc'],
  ['head', 'profile'], ['html', 'manifest'], ['iframe', 'src'], ['iframe', 'longdesc'],
  ['img', 'src'], ['img', 'longdesc'], ['input', 'src'], ['input', 'formaction'], ['ins', 'cite'],
  ['link', 'href'], ['object', 'classid'], ['object', 'codebase'], ['object', 'data'], ['q', 'cite'],
  ['script', 'src'], ['source', 'src'], ['track', 'src'], ['video', 'poster'], ['video', 'src'],
];

// Links from these tags lead to other documents and may be crawled further.
const NAVIGABLE = new Set(['a', 'area', 'frame', 'iframe', 'meta']);
const SKIP_REL = /\b(preconnect|dns-prefetch)\b/i;
const IGNORED_SCHEMES = /^(mailto|tel|sms|callto|javascript|data|about|blob|file|ftp|news|irc|skype|whatsapp|geo|market|intent):/i;

const clip = (s, n = 140) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Resolve a raw attribute value against a base URL.
 * Returns { url } | { invalid: true, url, reason } | null (ignored: anchors, mailto:, etc.)
 */
export function resolveLink(raw, base) {
  const value = String(raw ?? '').trim();
  if (!value || value.startsWith('#')) return null;
  if (IGNORED_SCHEMES.test(value)) return null;
  if (value.includes('\\')) return { invalid: true, url: value, reason: 'backslash' };
  let u;
  try { u = new URL(value, base); } catch { return { invalid: true, url: value, reason: 'unparseable' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  return { url: u.href };
}

export function extractCssUrls(css) {
  const out = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/gi;
  let m;
  while ((m = re.exec(css))) {
    const v = (m[2] ?? m[4] ?? '').trim();
    if (v && !/^data:/i.test(v)) out.push(v);
  }
  return out;
}

function parseSrcset(srcset) {
  return String(srcset || '').split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
}

/**
 * Extract every checkable link from an HTML document.
 * Also detects reCAPTCHA and, when checklist `rules` are given, finds text matches.
 * @returns {{ links: Array<{raw, text, tag, attr, navigable, nofollow}>, base: string, pageNofollow: boolean, title: string, captcha: object|null, matches: object[] }}
 */
export function extractFromHtml(html, pageUrl, { agentToken = 'linklantern', rules = [] } = {}) {
  const $ = cheerio.load(html);
  const links = [];

  let base = pageUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) { try { base = new URL(baseHref, pageUrl).href; } catch { /* keep page URL */ } }

  const robotsMeta = $('meta[name]').filter((_, el) => {
    const n = ($(el).attr('name') || '').toLowerCase();
    return n === 'robots' || n === agentToken.toLowerCase();
  }).map((_, el) => ($(el).attr('content') || '').toLowerCase()).get().join(',');
  const pageNofollow = /\b(nofollow|none)\b/.test(robotsMeta);

  const push = (raw, el, tag, attr) => {
    const $el = $(el);
    let text;
    if (tag === 'a' || tag === 'area') {
      text = clip($el.text()) || clip($el.find('img[alt]').attr('alt')) || clip($el.attr('title')) || clip($el.attr('alt'));
      if (!text) text = $el.find('img').length ? '[image link]' : '[no link text]';
    } else {
      text = `<${tag} ${attr}>`;
      const alt = clip($el.attr('alt') || $el.attr('title') || '', 60);
      if (alt) text += ` ${alt}`;
    }
    const rel = ($el.attr('rel') || '').toLowerCase();
    links.push({ raw, text, tag, attr, navigable: NAVIGABLE.has(tag), nofollow: /\bnofollow\b/.test(rel) });
  };

  for (const [tag, attr] of URL_ATTRIBUTES) {
    $(`${tag}[${attr}]`).each((_, el) => {
      if (tag === 'link' && SKIP_REL.test($(el).attr('rel') || '')) return;
      if (tag === 'form' && ($(el).attr('method') || 'get').toLowerCase() === 'post') return; // never probe POST endpoints
      const value = $(el).attr(attr);
      if (tag === 'object' && attr === 'classid' && /^clsid:/i.test(value || '')) return;
      push(value, el, tag, attr);
    });
  }

  // srcset on <img> and <source>
  $('img[srcset], source[srcset]').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    for (const u of parseSrcset($(el).attr('srcset'))) push(u, el, tag, 'srcset');
  });

  // <meta http-equiv="refresh" content="5; url=...">
  $('meta[http-equiv]').each((_, el) => {
    if (($(el).attr('http-equiv') || '').toLowerCase() !== 'refresh') return;
    const m = /url\s*=\s*['"]?([^'"]+)/i.exec($(el).attr('content') || '');
    if (m) push(m[1].trim(), el, 'meta', 'refresh');
  });

  // url() in inline style attributes and <style> blocks
  $('[style]').each((_, el) => {
    for (const u of extractCssUrls($(el).attr('style'))) push(u, el, el.tagName.toLowerCase(), 'style');
  });
  $('style').each((_, el) => {
    for (const u of extractCssUrls($(el).html() || '')) push(u, el, 'style', 'url()');
  });

  const title = clip($('title').first().text(), 120);
  const captcha = detectRecaptcha($);
  let matches = [];
  if (rules.length) { const { text, contacts } = pageText($); matches = findMatches(text, rules, contacts); }
  return { links, base, pageNofollow, title, captcha, matches };
}
