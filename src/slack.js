// Slack delivery through Incoming Webhooks. Each user stores one webhook URL
// (Account settings) and ticks "Send report to Slack" per scan or schedule.
// Only Slack's own webhook hosts are accepted, so the URL can't be used to make
// the server call arbitrary addresses.
const WEBHOOK_HOSTS = new Set(['hooks.slack.com', 'hooks.slack-gov.com']);
const MAX_SECTION = 2900; // Slack's limit is 3000 characters per text block

export function validateWebhookUrl(input) {
  const s = String(input || '').trim();
  let u;
  try { u = new URL(s); } catch { throw new Error('That is not a valid Slack webhook URL.'); }
  if (u.protocol !== 'https:' || !WEBHOOK_HOSTS.has(u.hostname) || u.port || u.username || u.password
    || !/^\/(services|triggers|workflows)\/[\w/-]+$/.test(u.pathname)) {
    throw new Error('Use a Slack Incoming Webhook URL, such as https://hooks.slack.com/services/T000/B000/XXXX.');
  }
  return u.href;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url, text) => `<${esc(url).replace(/\|/g, '%7C')}|${esc(text)}>`;
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };
const n = (v) => Number(v || 0).toLocaleString('en-US');
const clipText = (s) => (s.length > MAX_SECTION ? `${s.slice(0, MAX_SECTION - 1)}…` : s);

function reportBlocks(report, baseUrl, maxRows) {
  const s = report.stats || {};
  const reportUrl = `${baseUrl}/report/${report.id}`;
  let summary = `*${link(reportUrl, hostOf(report.startUrl))}*\n`;
  if (report.fatal) summary += `:warning: ${esc(report.fatal)}`;
  else {
    summary += `${n(s.pagesScanned)} pages · ${n(s.linksChecked)} links · *${n(s.broken)} broken* · ${n(s.redirected)} redirected`;
    if (s.captchaPages) summary += ` · ${n(s.captchaPages)} page${s.captchaPages === 1 ? '' : 's'} with reCAPTCHA`;
    if (s.textMatches) summary += ` · ${n(s.textMatches)} checklist match${s.textMatches === 1 ? '' : 'es'}`;
    if (report.state === 'stopped') summary += ' _(stopped early)_';
  }
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: clipText(summary) } }];

  const broken = (report.links || []).filter((l) => l.result === 'broken');
  if (broken.length) {
    const lines = broken.slice(0, maxRows).map((l) => {
      const page = l.occurrences?.[0]?.page;
      return `• \`${esc(l.status ?? l.error ?? '?')}\` ${link(l.url, l.url)}${page ? ` on ${link(page, new URL(page).pathname || '/')}` : ''}`;
    });
    if (broken.length > maxRows) lines.push(`_…and ${n(broken.length - maxRows)} more in the ${link(reportUrl, 'full report')}._`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clipText(lines.join('\n')) } });
  }
  return blocks;
}

/**
 * Build a webhook payload for one or more finished reports.
 * @param {object[]} reports full reports (with links)
 */
export function buildSlackMessage(reports, baseUrl, { title } = {}) {
  const totalBroken = reports.reduce((t, r) => t + (r.stats?.broken || 0), 0);
  const heading = title || (reports.length === 1
    ? `Link check: ${totalBroken} broken link${totalBroken === 1 ? '' : 's'} on ${hostOf(reports[0].startUrl)}`
    : `Multi check: ${totalBroken} broken link${totalBroken === 1 ? '' : 's'} across ${reports.length} sites`);
  const maxRows = reports.length === 1 ? 10 : 3;
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: heading.slice(0, 150), emoji: true } }];
  reports.forEach((r, i) => {
    if (i) blocks.push({ type: 'divider' });
    blocks.push(...reportBlocks(r, baseUrl, maxRows));
  });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Sent by LinkLantern · ${link(`${baseUrl}/reports`, 'all reports')}` }] });
  return { text: heading, blocks: blocks.slice(0, 50) };
}

export function createSlack() {
  async function post(webhookUrl, payload) {
    const url = validateWebhookUrl(webhookUrl);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Slack answered ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }
  return { post };
}
