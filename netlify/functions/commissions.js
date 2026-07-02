/* Untapped KPI Tracker — commission reminders + monthly summary (scheduled)
 * Cron "0 9 15,18,19 * *" (set in netlify.toml):
 *   15th → remind each client they have until the 18th to submit commissions/bonuses
 *   18th → final reminder to each client (submit today or it won't be paid)
 *   19th → email Untapped a summary of the month's commissions across all clients
 * Env: RESEND_API_KEY, FROM_EMAIL, SITE_URL (+ Blobs token on manual deploys)
 */
const TEAM = ['kyle@tryuntapped.com', 'Nina@tryuntapped.com', 'pau@tryuntapped.com'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function sendEmail(apiKey, payload) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + await r.text());
}
function wrap(heading, body) {
  return `<!doctype html><html><body style="margin:0;background:#fbf8fd;font-family:Helvetica,Arial,sans-serif;color:#1a1424">
    <div style="background:#101820;padding:20px 28px"><span style="color:#fff;font-size:20px;font-weight:700">untapped</span></div>
    <div style="height:4px;background:linear-gradient(90deg,#FFC600,#FF6900,#DA291C)"></div>
    <div style="max-width:620px;margin:0 auto;padding:28px">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:23px;margin:0 0 14px">${esc(heading)}</h1>
      ${body}
      <p style="color:#999;font-size:12px;margin-top:24px">Untapped · tryuntapped.com</p>
    </div></body></html>`;
}
function curMonth() { return new Date().toISOString().slice(0, 7); }
function monthLabel(m) { return new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }

exports.handler = async () => {
  const { RESEND_API_KEY, FROM_EMAIL } = process.env;
  const SITE_URL = process.env.SITE_URL || 'https://untappedkpitracker.netlify.app';
  if (!RESEND_API_KEY || !FROM_EMAIL) return { statusCode: 200, body: 'email not configured' };
  const day = new Date().getUTCDate();
  const month = curMonth();
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
    ? { name: 'kpi-workspaces', siteID: process.env.BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }
    : 'kpi-workspaces');
  let all = [];
  try {
    const { blobs } = await store.list();
    for (const bl of blobs) { const ws = await store.get(bl.key, { type: 'json' }); if (ws) all.push(ws); }
  } catch (e) { return { statusCode: 500, body: 'error: ' + e.message }; }

  let sent = 0;

  if (day === 15 || day === 18) {
    const heading = day === 15 ? 'Reminder: submit commissions by the 18th' : 'Final reminder: commissions due today';
    for (const ws of all) {
      if (!ws.customerEmail) continue;
      const link = SITE_URL ? `${SITE_URL.replace(/\/$/, '')}/?w=${ws.id}` : '';
      const intro = day === 15
        ? `<p style="font-size:15px;color:#333">This is a reminder that you have until the <b>18th of ${monthLabel(month)}</b> to submit any commissions or bonuses due to your team this month, via the Commissions tab in your tracker.</p>`
        : `<p style="font-size:15px;color:#333"><b>Final reminder — today is the deadline.</b> Please submit any commissions or bonuses due this month now. Anything not submitted by the end of today will not be paid.</p>`;
      const body = intro + (link ? `<p style="margin-top:18px"><a href="${link}" style="background:#101820;color:#fff;text-decoration:none;padding:11px 20px;border-radius:4px;font-size:14px">Open the Commissions tab →</a></p>` : '');
      try { await sendEmail(RESEND_API_KEY, { from: FROM_EMAIL, to: [ws.customerEmail], subject: (day === 15 ? 'Reminder' : 'Final reminder') + ' — commissions for ' + monthLabel(month), html: wrap(heading, body) }); sent++; } catch (e) {}
    }
    return { statusCode: 200, body: 'client reminders sent: ' + sent };
  }

  if (day === 19) {
    let rows = '', grand = 0;
    for (const ws of all) {
      const items = (ws.commissions || []).filter(x => x.month === month);
      if (!items.length) continue;
      const subtotal = items.reduce((t, x) => t + (Number(x.amount) || 0), 0); grand += subtotal;
      rows += `<tr><td colspan="3" style="padding:14px 10px 4px;font-weight:700;border-top:2px solid #1a1424">${esc(ws.company || 'Workspace')} — £${subtotal.toFixed(2)}</td></tr>`;
      items.forEach(x => { rows += `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(x.candidateName || '—')}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(x.type)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">£${(Number(x.amount) || 0).toFixed(2)}${x.note ? ` <span style="color:#999">· ${esc(x.note)}</span>` : ''}</td></tr>`; });
    }
    const body = rows
      ? `<p style="font-size:15px;color:#333">Commissions &amp; bonuses submitted by clients for <b>${monthLabel(month)}</b>:</p><table style="border-collapse:collapse;width:100%;font-size:14px">${rows}<tr><td colspan="3" style="padding:14px 10px;font-weight:700;border-top:2px solid #1a1424">Grand total — £${grand.toFixed(2)}</td></tr></table>`
      : `<p style="font-size:15px;color:#333">No commissions or bonuses were submitted by clients for ${monthLabel(month)}.</p>`;
    try { await sendEmail(RESEND_API_KEY, { from: FROM_EMAIL, to: TEAM, subject: 'Commissions due — ' + monthLabel(month), html: wrap('Monthly commissions summary', body) }); sent++; } catch (e) {}
    return { statusCode: 200, body: 'summary sent: ' + sent };
  }

  return { statusCode: 200, body: 'no action for day ' + day };
};
