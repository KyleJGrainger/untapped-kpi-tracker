/* Untapped KPI Tracker — scheduled Friday digest
 * Emails each workspace's customer a weekly roster summary.
 * Schedule is set in netlify.toml ([functions."digest"] schedule = "0 14 * * 5").
 * Env: RESEND_API_KEY, FROM_EMAIL, SITE_URL
 */
// @netlify/blobs is ESM-only — loaded via dynamic import() inside the handler.
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function weekKey(d){const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-day);const ys=new Date(Date.UTC(t.getUTCFullYear(),0,1));const wk=Math.ceil(((t-ys)/86400000+1)/7);return t.getUTCFullYear()+'-W'+String(wk).padStart(2,'0');}
function completion(kpis, logs, period, pk){
  const list=(kpis&&kpis[period])||[]; if(!list.length) return null;
  const log=((logs&&logs[period])||{})[pk]||{};
  let sum=0; list.forEach(it=>{ const v=log[it.id]; if(it.type==='check') sum+=v?1:0; else sum+= it.target?Math.min(1,(Number(v)||0)/it.target):(v?1:0); });
  return Math.round(100*sum/list.length);
}
const rag = p => p==null?'—':p>=75?'On track':p>=50?'Watch':'At risk';
async function sendEmail(apiKey, payload){
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) throw new Error('Resend '+r.status+': '+await r.text());
}
function html(ws, siteUrl){
  const wk=weekKey(new Date());
  const link=siteUrl?`${siteUrl.replace(/\/$/,'')}/?w=${ws.id}`:'';
  const rows=(ws.candidates||[]).map(c=>{
    const wkp=completion(c.kpis,c.logs,'weekly',wk);
    const last=c.lastActivity?new Date(c.lastActivity).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'none';
    const open=(c.blockers||[]).filter(b=>!b.resolved).length;
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #e7e1ef">${esc(c.name)}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e7e1ef;font-weight:700">${wkp==null?'—':wkp+'%'}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e7e1ef">${rag(wkp)}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e7e1ef">${last}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #e7e1ef">${open||'—'}</td></tr>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;background:#fbf8fd;font-family:Helvetica,Arial,sans-serif;color:#1a1424">
    <div style="background:#101820;padding:20px 28px"><span style="color:#fff;font-size:20px;font-weight:700">untapped</span></div>
    <div style="height:4px;background:linear-gradient(90deg,#FFC600,#FF6900,#DA291C)"></div>
    <div style="max-width:640px;margin:0 auto;padding:28px">
      <p style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#777;margin:0 0 4px">Weekly performance digest</p>
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 14px">${esc(ws.company||'Your team')}</h1>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <tr><th style="text-align:left;padding:9px 12px;border-bottom:2px solid #1a1424;font-size:11px;letter-spacing:.08em;text-transform:uppercase">Candidate</th>
        <th style="text-align:left;padding:9px 12px;border-bottom:2px solid #1a1424;font-size:11px;letter-spacing:.08em;text-transform:uppercase">Week</th>
        <th style="text-align:left;padding:9px 12px;border-bottom:2px solid #1a1424;font-size:11px;letter-spacing:.08em;text-transform:uppercase">Status</th>
        <th style="text-align:left;padding:9px 12px;border-bottom:2px solid #1a1424;font-size:11px;letter-spacing:.08em;text-transform:uppercase">Last log</th>
        <th style="text-align:left;padding:9px 12px;border-bottom:2px solid #1a1424;font-size:11px;letter-spacing:.08em;text-transform:uppercase">Blockers</th></tr>
        ${rows||'<tr><td style="padding:12px">No candidates yet.</td></tr>'}
      </table>
      ${link?`<p style="margin-top:22px"><a href="${link}" style="background:#101820;color:#fff;text-decoration:none;padding:11px 20px;border-radius:4px;font-size:14px">Open the dashboard →</a></p>`:''}
      <p style="color:#999;font-size:12px;margin-top:24px">Untapped · Performance Tracker · tryuntapped.com</p>
    </div></body></html>`;
}

exports.handler = async () => {
  const { RESEND_API_KEY, FROM_EMAIL } = process.env;
  const SITE_URL = process.env.SITE_URL || 'https://untapped-kpi-tracker-v2.netlify.app';
  if (!RESEND_API_KEY || !FROM_EMAIL) return { statusCode: 200, body: 'email not configured' };
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
    ? { name: 'kpi-workspaces', siteID: process.env.BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }
    : 'kpi-workspaces');
  let sent = 0;
  try {
    const { blobs } = await store.list();
    for (const bl of blobs) {
      const ws = await store.get(bl.key, { type: 'json' });
      if (!ws || !ws.customerEmail) continue;
      try { await sendEmail(RESEND_API_KEY, { from: FROM_EMAIL, to: [ws.customerEmail], subject: `Weekly update — ${ws.company || 'your team'}`, html: html(ws, SITE_URL) }); sent++; }
      catch (e) { /* skip one, continue */ }
    }
  } catch (e) { return { statusCode: 500, body: 'error: ' + e.message }; }
  return { statusCode: 200, body: 'digests sent: ' + sent };
};
