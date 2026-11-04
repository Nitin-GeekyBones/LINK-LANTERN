// A small self-hosted image captcha used for guest scans. It is a speed bump,
// not a strong bot defence - per-IP rate limits do the heavy lifting. To use a
// hosted service (Cloudflare Turnstile, hCaptcha) replace create()/verify().
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const TTL = 10 * 60 * 1000;

export function createCaptcha() {
  const pending = new Map(); // id -> { code, expires }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  }, 60000).unref();

  function rand(n) { return crypto.randomInt(n); }

  function svgFor(code) {
    const w = 150; const h = 50;
    let parts = '';
    for (let i = 0; i < 6; i++) {
      parts += `<path d="M${rand(w)} ${rand(h)} Q${rand(w)} ${rand(h)} ${rand(w)} ${rand(h)}" stroke="hsl(${rand(360)},45%,55%)" stroke-width="${1 + rand(2)}" fill="none" opacity=".7"/>`;
    }
    // characters are emitted in shuffled DOM order with explicit x positions
    const glyphs = [...code].map((ch, i) => ({ ch, i })).sort(() => rand(3) - 1);
    for (const { ch, i } of glyphs) {
      const x = 16 + i * 25 + rand(5);
      const y = 33 + rand(9) - 4;
      const rot = rand(40) - 20;
      parts += `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-family="Georgia,serif" font-size="${26 + rand(6)}" font-weight="700" fill="hsl(${rand(360)},55%,30%)">${ch}</text>`;
    }
    for (let i = 0; i < 40; i++) parts += `<circle cx="${rand(w)}" cy="${rand(h)}" r="1" fill="#555" opacity=".5"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Security code image"><rect width="100%" height="100%" fill="#f6f1e7"/>${parts}</svg>`;
  }

  function create() {
    const code = Array.from({ length: 5 }, () => ALPHABET[rand(ALPHABET.length)]).join('');
    const id = crypto.randomBytes(12).toString('base64url');
    pending.set(id, { code, expires: Date.now() + TTL });
    if (pending.size > 50000) pending.delete(pending.keys().next().value);
    return { id, svg: svgFor(code) };
  }

  /** One-time verification (the entry is consumed either way). */
  function verify(id, answer) {
    const entry = pending.get(String(id || ''));
    pending.delete(String(id || ''));
    if (!entry || entry.expires < Date.now()) return false;
    return entry.code === String(answer || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  return { create, verify };
}
