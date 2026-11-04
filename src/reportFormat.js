// Report exports: CSV (one row per link occurrence) and an HTML email body.
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  // neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function reportToCsv(report, { only = 'all' } = {}) {
  const header = ['result', 'status_code', 'status', 'url', 'final_url', 'redirect_chain', 'internal', 'found_on_page', 'link_text', 'element', 'occurrences'];
  const rows = [header.join(',')];
  for (const l of report.links || []) {
    if (only === 'problems' && l.result === 'ok') continue;
    const chain = (l.redirects || []).map((h) => `${h.status} ${h.url}`).join(' -> ');
    const occs = l.occurrences && l.occurrences.length ? l.occurrences : [{ page: l.isStart ? '(starting URL)' : '', text: '', tag: '', attr: '' }];
    for (const o of occs) {
      rows.push([
        l.result, l.status ?? '', l.label, l.url, l.finalUrl ?? '', chain, l.internal ? 'yes' : 'no',
        o.page, o.text, o.tag ? `${o.tag}/${o.attr}` : '', l.occurrenceCount ?? '',
      ].map(csvCell).join(','));
    }
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function reportSummaryHtml(report, baseUrl, { maxRows = 200 } = {}) {
  const s = report.stats || {};
  const broken = (report.links || []).filter((l) => l.result === 'broken');
  const rows = broken.slice(0, maxRows).map((l) => {
    const o = (l.occurrences || [])[0] || {};
    return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;color:#b42318;white-space:nowrap">${esc(l.label)}</td>
<td style="padding:6px 8px;border-bottom:1px solid #eee;word-break:break-all"><a href="${esc(l.url)}">${esc(l.url)}</a></td>
<td style="padding:6px 8px;border-bottom:1px solid #eee;word-break:break-all">${esc(o.text)}<br><small style="color:#666">on ${esc(o.page)}</small></td></tr>`;
  }).join('');
  const more = broken.length > maxRows ? `<p>…and ${broken.length - maxRows} more. See the full report online.</p>` : '';
  return `<div style="font-family:system-ui,sans-serif;max-width:760px">
<h2 style="margin:0 0 4px">${esc(report.startUrl)}</h2>
<p style="margin:0 0 12px;color:#555">${report.fatal ? esc(report.fatal) : `${s.pagesScanned || 0} pages scanned · ${s.linksChecked || 0} links checked · <b style="color:${s.broken ? '#b42318' : '#067647'}">${s.broken || 0} broken</b> · ${s.redirected || 0} redirected`}</p>
${broken.length ? `<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr><th align="left" style="padding:6px 8px;border-bottom:2px solid #ccc">Status</th><th align="left" style="padding:6px 8px;border-bottom:2px solid #ccc">URL</th><th align="left" style="padding:6px 8px;border-bottom:2px solid #ccc">Link text / page</th></tr></thead><tbody>${rows}</tbody></table>${more}` : (report.fatal ? '' : '<p>No broken links found. 🎉</p>')}
<p><a href="${esc(baseUrl)}/report/${esc(report.id)}">Open the full report</a> · <a href="${esc(baseUrl)}/api/scans/${esc(report.id)}/export.csv">Download CSV</a></p>
</div>`;
}
