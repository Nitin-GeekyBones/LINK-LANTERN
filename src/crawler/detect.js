// Page-level findings: CAPTCHA detection and content checklist matching.
// Both run on every crawled HTML page (never on external pages).

// ---------- Google reCAPTCHA ----------
const RECAPTCHA_SCRIPT = /(?:^|\/\/)(?:www\.)?(?:google\.com|recaptcha\.net|gstatic\.com)\/recaptcha\//i;
const RECAPTCHA_IFRAME = /(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)/i;
const SITE_KEY = /^[\w-]{20,64}$/;

/**
 * Detect Google reCAPTCHA in a parsed page.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {null | { type: 'recaptcha', variant: string, siteKey: string|null, evidence: string[] }}
 */
export function detectRecaptcha($) {
  const evidence = new Set();
  let enterprise = false;
  let v3Key = null;
  let explicit = false;

  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!RECAPTCHA_SCRIPT.test(src)) return;
    evidence.add('script');
    if (/\/enterprise\.js/i.test(src)) enterprise = true;
    let render = null;
    try { render = new URL(src, 'https://www.google.com/').searchParams.get('render'); } catch { /* ignore */ }
    if (render === 'explicit') explicit = true;
    else if (render && SITE_KEY.test(render)) v3Key = render;
  });

  const widget = $('.g-recaptcha, [data-sitekey]').filter((_, el) => {
    const $el = $(el);
    return $el.hasClass('g-recaptcha') || SITE_KEY.test($el.attr('data-sitekey') || '');
  }).first();
  if (widget.length) evidence.add('widget');

  $('iframe[src]').each((_, el) => { if (RECAPTCHA_IFRAME.test($(el).attr('src') || '')) evidence.add('iframe'); });

  let inline = '';
  $('script:not([src])').each((_, el) => { inline += `${$(el).html() || ''}\n`; });
  if (/\bgrecaptcha\s*\.\s*(?:enterprise\s*\.\s*)?(?:execute|render|ready)\b/.test(inline)) evidence.add('inline-script');
  if (/\bgrecaptcha\s*\.\s*enterprise\b/.test(inline)) enterprise = true;

  if (!evidence.size) return null;

  const widgetKey = widget.attr('data-sitekey');
  const siteKey = v3Key || (widgetKey && SITE_KEY.test(widgetKey) ? widgetKey : null);
  let variant;
  if (enterprise) variant = 'Enterprise';
  else if (v3Key || (!widget.length && /\bgrecaptcha\s*\.\s*execute\b/.test(inline) && !explicit)) variant = 'v3';
  else if (widget.length && (widget.attr('data-size') || '').toLowerCase() === 'invisible') variant = 'v2 invisible';
  else if (widget.length || explicit || evidence.has('iframe')) variant = 'v2 checkbox';
  else variant = 'unknown';

  return { type: 'recaptcha', variant, siteKey, evidence: [...evidence] };
}

// ---------- content checklist ----------
export const CHECKLIST_PRESETS = {
  email: {
    label: 'Email addresses',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  phone: {
    label: 'Phone numbers',
    re: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}(?![\w])/g,
    // 9-15 digits (E.164), and not something that looks like a date or a version number
    accept: (m) => {
      const digits = m.replace(/\D/g, '').length;
      if (digits < 9 || digits > 15) return false;
      if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(m) || /^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(m)) return false;
      return /[\s()+-]/.test(m); // a bare run of digits with dots is more likely an ID than a phone number
    },
  },
  price: {
    label: 'Prices',
    re: /(?:[$€£¥₹]\s?\d[\d,.]*\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP|INR)\b)/g,
  },
  placeholder: {
    label: 'Placeholder text',
    re: /\b(?:lorem ipsum|dolor sit amet|TODO|FIXME|TBD|coming soon|placeholder)\b/gi,
  },
  copyright: {
    label: 'Copyright notices',
    re: /(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?\d{4}/gi,
  },
};

const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 100;

/**
 * Validate a checklist from user input. Returns null when nothing is selected.
 * Custom terms are matched as plain text (never as user-supplied regex), so a
 * hostile pattern can't stall the crawler.
 */
export function normalizeChecklist(input) {
  if (!input || typeof input !== 'object') return null;
  const presets = [...new Set((Array.isArray(input.presets) ? input.presets : []).map(String))]
    .filter((p) => p in CHECKLIST_PRESETS);
  const rawTerms = Array.isArray(input.terms) ? input.terms : String(input.terms || '').split(/\r?\n/);
  const terms = [...new Set(rawTerms.map((t) => String(t).trim()).filter(Boolean))];
  if (terms.length > MAX_TERMS) throw new Error(`The checklist accepts up to ${MAX_TERMS} search terms.`);
  const long = terms.find((t) => t.length > MAX_TERM_LENGTH);
  if (long) throw new Error(`Search terms can be up to ${MAX_TERM_LENGTH} characters long.`);
  if (!presets.length && !terms.length) return null;
  return { presets, terms, caseSensitive: !!input.caseSensitive, wholeWord: !!input.wholeWord };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Turn a normalized checklist into matcher rules. */
export function compileChecklist(cl) {
  if (!cl) return [];
  const rules = cl.presets.map((id) => ({ id, label: CHECKLIST_PRESETS[id].label, re: CHECKLIST_PRESETS[id].re, accept: CHECKLIST_PRESETS[id].accept }));
  for (const term of cl.terms) {
    const body = escapeRegex(term);
    const src = cl.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
    rules.push({ id: 'term', label: `"${term}"`, re: new RegExp(src, cl.caseSensitive ? 'gu' : 'giu') });
  }
  return rules;
}

/**
 * Visible text of a page, plus mailto:/tel: targets (contact details often live only there).
 * @returns {{ text: string, contacts: string[] }}
 */
export function pageText($) {
  const body = $('body').length ? $('body').clone() : $.root().clone();
  body.find('script, style, noscript, template, svg, iframe').remove();
  body.find('br, p, div, li, td, th, h1, h2, h3, h4, h5, h6, section, article, header, footer, tr').after('\n');
  const text = body.text().replace(/[ \t\f\v ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const contacts = $('a[href^="mailto:" i], a[href^="tel:" i]').map((_, el) => {
    const v = ($(el).attr('href') || '').replace(/^(mailto|tel):/i, '').split('?')[0];
    try { return decodeURIComponent(v); } catch { return v; }
  }).get().filter(Boolean);
  return { text, contacts: [...new Set(contacts)] };
}

const PER_RULE_PER_PAGE = 25;
const SNIPPET = 50;

/**
 * Run the rules over a page's text, then its email/phone link targets.
 * Each distinct match is reported once per page.
 */
export function findMatches(text, rules, contacts = []) {
  const out = [];
  const sources = [{ text, link: false }, ...contacts.map((c) => ({ text: c, link: true }))];
  for (const rule of rules) {
    const seen = new Set();
    for (const src of sources) {
      for (const m of src.text.matchAll(rule.re)) {
        const value = m[0].trim();
        if (!value || seen.has(value) || (rule.accept && !rule.accept(value))) continue;
        seen.add(value);
        let snippet = `Link to ${src.text}`;
        if (!src.link) {
          const from = Math.max(0, m.index - SNIPPET);
          const to = Math.min(src.text.length, m.index + m[0].length + SNIPPET);
          snippet = `${from > 0 ? '…' : ''}${src.text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < src.text.length ? '…' : ''}`;
        }
        out.push({ rule: rule.id, ruleLabel: rule.label, match: value, snippet });
        if (seen.size >= PER_RULE_PER_PAGE) break;
      }
      if (seen.size >= PER_RULE_PER_PAGE) break;
    }
  }
  return out;
}
