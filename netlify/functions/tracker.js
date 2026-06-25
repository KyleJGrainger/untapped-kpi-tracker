/* Untapped KPI Tracker — cloud API (Netlify Function + Blobs)
 *
 * Model: a customer WORKSPACE (one client) holds many CANDIDATES.
 *   - Customer PIN  → manage KPIs, see oversight dashboard, leave kudos, view pulse/blockers, add candidates.
 *   - Candidate PIN → log KPIs, submit weekly pulse, raise blockers, read kudos.
 * Access via unguessable workspace id in the link (no accounts). PIN-gated, action-based.
 *
 * Env (only for digest emails): RESEND_API_KEY, FROM_EMAIL, SITE_URL
 */
// @netlify/blobs is ESM-only — loaded via dynamic import() inside the handler.
const json = (s, o) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function weekKey(d){const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-day);const ys=new Date(Date.UTC(t.getUTCFullYear(),0,1));const wk=Math.ceil(((t-ys)/86400000+1)/7);return t.getUTCFullYear()+'-W'+String(wk).padStart(2,'0');}
function completion(kpis, logs, period, pk){
  const list=(kpis&&kpis[period])||[]; if(!list.length) return null;
  const log=((logs&&logs[period])||{})[pk]||{};
  let sum=0; list.forEach(it=>{ const v=log[it.id]; if(it.type==='check') sum+=v?1:0; else sum+= it.target?Math.min(1,(Number(v)||0)/it.target):(v?1:0); });
  return Math.round(100*sum/list.length);
}
async function sendEmail(apiKey, payload){
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) throw new Error('Resend '+r.status+': '+await r.text());
}
function rag(p){ return p==null?'—':p>=75?'On track':p>=50?'Watch':'At risk'; }
function digestHTML(ws, siteUrl){
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

function findCandidate(ws, id){ return (ws.candidates||[]).find(c=>c.id===id); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
    ? { name: 'kpi-workspaces', siteID: process.env.BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }
    : 'kpi-workspaces');
  const { action } = b;

  if (action === 'create') {
    if (!/^\d{4}$/.test(String(b.customerPin)) || !/^\d{4}$/.test(String(b.candidatePin)))
      return json(400, { error: 'PINs must be 4 digits' });
    const wsId = uid();
    const candId = uid();
    const ws = {
      id: wsId, company: b.company || '', customerEmail: b.customerEmail || '',
      customerPin: String(b.customerPin), createdAt: new Date().toISOString(),
      candidates: [{
        id: candId, name: b.candidate || 'Candidate', role: b.role || '',
        candidatePin: String(b.candidatePin), createdAt: new Date().toISOString(),
        kpis: { daily: [], weekly: [], monthly: [] }, logs: { daily: {}, weekly: {}, monthly: {} },
        pulse: {}, blockers: [], kudos: [], lastActivity: null
      }]
    };
    await store.setJSON(wsId, ws);
    return json(200, { ok: true, wsId, candidateId: candId });
  }

  const wsId = b.wsId; if (!wsId) return json(400, { error: 'missing wsId' });
  const ws = await store.get(wsId, { type: 'json' });
  if (!ws) return json(404, { error: 'not found' });

  const isCustomer = String(b.pin) === ws.customerPin;
  const candByPin = (ws.candidates || []).find(c => c.candidatePin === String(b.pin));
  if (!isCustomer && !candByPin) return json(401, { error: 'incorrect pin' });
  const role = isCustomer ? 'customer' : 'candidate';

  // GET — customer sees whole workspace; candidate sees only their own record
  if (action === 'get') {
    if (isCustomer) {
      const { customerPin, ...safe } = ws; // keep candidate pins so customer can share links
      return json(200, { ok: true, role, workspace: safe });
    }
    const { candidatePin, ...c } = candByPin;
    return json(200, { ok: true, role, company: ws.company, candidate: c });
  }

  const save = async () => { await store.setJSON(wsId, ws); };

  if (action === 'addCandidate') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    if (!/^\d{4}$/.test(String(b.candidatePin))) return json(400, { error: 'PIN must be 4 digits' });
    const c = { id: uid(), name: b.name || 'Candidate', role: b.role || '', candidatePin: String(b.candidatePin),
      createdAt: new Date().toISOString(), kpis: { daily: [], weekly: [], monthly: [] },
      logs: { daily: {}, weekly: {}, monthly: {} }, pulse: {}, blockers: [], kudos: [], lastActivity: null };
    ws.candidates.push(c); await save();
    return json(200, { ok: true, candidateId: c.id });
  }
  if (action === 'saveKpis') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    const c = findCandidate(ws, b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
    if (b.kpis) c.kpis = b.kpis; await save(); return json(200, { ok: true });
  }
  if (action === 'addKudos') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    const c = findCandidate(ws, b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
    c.kudos = c.kudos || []; c.kudos.unshift({ id: uid(), text: String(b.text || '').slice(0, 500), ts: new Date().toISOString() });
    await save(); return json(200, { ok: true });
  }
  if (action === 'digestNow') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    const { RESEND_API_KEY, FROM_EMAIL, SITE_URL } = process.env;
    if (!RESEND_API_KEY || !FROM_EMAIL || !ws.customerEmail) return json(200, { ok: false, note: 'email not configured' });
    try { await sendEmail(RESEND_API_KEY, { from: FROM_EMAIL, to: [ws.customerEmail], subject: `Weekly update — ${ws.company || 'your team'}`, html: digestHTML(ws, SITE_URL) }); return json(200, { ok: true }); }
    catch (e) { return json(502, { error: e.message }); }
  }

  // Candidate (or customer acting on a candidate they own) actions
  const targetId = b.candidateId || (candByPin && candByPin.id);
  const c = findCandidate(ws, targetId);
  if (!c) return json(404, { error: 'candidate not found' });
  // candidate may only act on their own record
  if (role === 'candidate' && c.id !== candByPin.id) return json(403, { error: 'forbidden' });

  if (action === 'saveLog') {
    if (role !== 'candidate') return json(403, { error: 'only candidate logs' });
    const { period, periodKey, kpiId, value } = b;
    if (!['daily', 'weekly', 'monthly'].includes(period)) return json(400, { error: 'bad period' });
    c.logs[period] = c.logs[period] || {}; c.logs[period][periodKey] = c.logs[period][periodKey] || {};
    if (value === null || value === undefined) delete c.logs[period][periodKey][kpiId]; else c.logs[period][periodKey][kpiId] = value;
    c.lastActivity = new Date().toISOString(); await save(); return json(200, { ok: true });
  }
  if (action === 'savePulse') {
    if (role !== 'candidate') return json(403, { error: 'forbidden' });
    c.pulse = c.pulse || {}; c.pulse[b.weekKey] = { workload: b.workload, confidence: b.confidence, supported: b.supported, note: String(b.note || '').slice(0, 600), ts: new Date().toISOString() };
    c.lastActivity = new Date().toISOString(); await save(); return json(200, { ok: true });
  }
  if (action === 'addBlocker') {
    if (role !== 'candidate') return json(403, { error: 'forbidden' });
    c.blockers = c.blockers || []; c.blockers.unshift({ id: uid(), text: String(b.text || '').slice(0, 600), ts: new Date().toISOString(), resolved: false });
    c.lastActivity = new Date().toISOString(); await save(); return json(200, { ok: true });
  }
  if (action === 'resolveBlocker') {
    const bl = (c.blockers || []).find(x => x.id === b.blockerId); if (bl) bl.resolved = true; await save(); return json(200, { ok: true });
  }
  return json(400, { error: 'unknown action' });
};
