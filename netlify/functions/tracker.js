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

/* ---- Time Off: team recipients + 2026 public holidays (excluded from allowance) ---- */
const TEAM = ['kyle@tryuntapped.com', 'Nina@tryuntapped.com', 'pau@tryuntapped.com'];
const HOLIDAYS = {
  'South Africa': { '2026-01-01':"New Year's Day",'2026-03-21':'Human Rights Day','2026-04-03':'Good Friday','2026-04-06':'Family Day','2026-04-27':'Freedom Day','2026-05-01':"Workers' Day",'2026-06-16':'Youth Day','2026-08-10':"National Women's Day (observed)",'2026-09-24':'Heritage Day','2026-12-16':'Day of Reconciliation','2026-12-25':'Christmas Day','2026-12-26':'Day of Goodwill' },
  'Philippines': { '2026-01-01':"New Year's Day",'2026-02-17':'Chinese New Year','2026-04-02':'Maundy Thursday','2026-04-03':'Good Friday','2026-04-04':'Black Saturday','2026-04-09':'Araw ng Kagitingan','2026-05-01':'Labor Day','2026-06-12':'Independence Day','2026-08-21':'Ninoy Aquino Day','2026-08-31':'National Heroes Day','2026-11-01':"All Saints' Day",'2026-11-30':'Bonifacio Day','2026-12-08':'Immaculate Conception','2026-12-25':'Christmas Day','2026-12-30':'Rizal Day','2026-12-31':'Last Day of the Year' }
};
function isoD(d){ return d.toISOString().slice(0,10); }
function workingDays(start, end, loc){
  if(!start||!end) return { days:0, skipped:[] };
  const s=new Date(start+'T00:00:00Z'), e=new Date(end+'T00:00:00Z');
  if(isNaN(s)||isNaN(e)||e<s) return { days:0, skipped:[] };
  let days=0; const skipped=[];
  for(let d=new Date(s); d<=e; d.setUTCDate(d.getUTCDate()+1)){
    const wd=d.getUTCDay(); if(wd===0||wd===6) continue;
    const h=HOLIDAYS[loc] && HOLIDAYS[loc][isoD(d)];
    if(h){ skipped.push(h); continue; }
    days++;
  }
  return { days, skipped };
}
function bookedDays(c){ return (c.timeoff||[]).filter(r=>r.status==='approved').reduce((t,r)=>t+workingDays(r.start,r.end,c.location).days,0); }
async function mail(to, subject, html){
  const { RESEND_API_KEY, FROM_EMAIL } = process.env;
  const list = (Array.isArray(to)?to:[to]).filter(Boolean);
  if(!RESEND_API_KEY || !FROM_EMAIL || !list.length) return;
  try { await sendEmail(RESEND_API_KEY, { from: FROM_EMAIL, to: list, subject, html }); } catch(e){}
}
function emailWrap(heading, bodyHtml, ws, siteUrl){
  const link = siteUrl ? `${siteUrl.replace(/\/$/,'')}/?w=${ws.id}` : '';
  return `<!doctype html><html><body style="margin:0;background:#fbf8fd;font-family:Helvetica,Arial,sans-serif;color:#1a1424">
    <div style="background:#101820;padding:20px 28px"><span style="color:#fff;font-size:20px;font-weight:700">untapped</span></div>
    <div style="height:4px;background:linear-gradient(90deg,#FFC600,#FF6900,#DA291C)"></div>
    <div style="max-width:600px;margin:0 auto;padding:28px">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:23px;margin:0 0 14px">${esc(heading)}</h1>
      ${bodyHtml}
      ${link?`<p style="margin-top:22px"><a href="${link}" style="background:#101820;color:#fff;text-decoration:none;padding:11px 20px;border-radius:4px;font-size:14px">Open the tracker →</a></p>`:''}
      <p style="color:#999;font-size:12px;margin-top:24px">Untapped · tryuntapped.com</p>
    </div></body></html>`;
}
function dateRange(r){ const f=s=>new Date(s+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); return f(r.start)+' → '+f(r.end); }

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
      commissions: [],
      candidates: [{
        id: candId, name: b.candidate || 'Candidate', role: b.role || '',
        email: b.email || '', location: b.location || '', allowance: Number(b.allowance) || 20, timeoff: [],
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
      email: b.email || '', location: b.location || '', allowance: Number(b.allowance) || 20, timeoff: [],
      createdAt: new Date().toISOString(), kpis: { daily: [], weekly: [], monthly: [] },
      logs: { daily: {}, weekly: {}, monthly: {} }, pulse: {}, blockers: [], kudos: [], lastActivity: null };
    ws.candidates.push(c); await save();
    return json(200, { ok: true, candidateId: c.id });
  }
  if (action === 'editCandidate') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    const c = findCandidate(ws, b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
    if (b.name != null) c.name = String(b.name);
    if (b.role != null) c.role = String(b.role);
    if (b.email != null) c.email = String(b.email);
    if (b.location != null) c.location = String(b.location);
    if (b.allowance != null) c.allowance = Math.max(0, Number(b.allowance) || 0);
    await save(); return json(200, { ok: true });
  }
  if (action === 'addCommission') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    ws.commissions = ws.commissions || [];
    const month = /^\d{4}-\d{2}$/.test(String(b.month)) ? b.month : new Date().toISOString().slice(0, 7);
    ws.commissions.unshift({ id: uid(), candidateId: b.candidateId || '', candidateName: (findCandidate(ws, b.candidateId) || {}).name || '', amount: Math.max(0, Number(b.amount) || 0), type: b.type === 'Bonus' ? 'Bonus' : 'Commission', note: String(b.note || '').slice(0, 400), month, ts: new Date().toISOString() });
    await save(); return json(200, { ok: true });
  }
  if (action === 'deleteCommission') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    ws.commissions = (ws.commissions || []).filter(x => x.id !== b.commissionId);
    await save(); return json(200, { ok: true });
  }
  if (action === 'decideTimeoff') {
    if (!isCustomer) return json(403, { error: 'forbidden' });
    const c = findCandidate(ws, b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
    const r = (c.timeoff || []).find(x => x.id === b.requestId); if (!r) return json(404, { error: 'request not found' });
    if (!['approved', 'declined'].includes(b.status)) return json(400, { error: 'bad status' });
    r.status = b.status; r.decidedAt = new Date().toISOString();
    await save();
    const calc = workingDays(r.start, r.end, c.location);
    const verb = b.status === 'approved' ? 'approved' : 'declined';
    const remaining = c.allowance - bookedDays(c);
    const body = `<p style="font-size:15px;color:#333;margin:0 0 14px"><b>${esc(c.name)}</b>'s time-off request has been <b>${verb}</b>.</p>
      <table style="border-collapse:collapse;font-size:14px;margin:0 0 8px">
      <tr><td style="padding:4px 14px 4px 0;color:#777">Dates</td><td style="padding:4px 0">${dateRange(r)}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#777">Working days</td><td style="padding:4px 0">${calc.days}${calc.skipped.length?` (excludes ${calc.skipped.length} public holiday)`:''}</td></tr>
      ${r.reason?`<tr><td style="padding:4px 14px 4px 0;color:#777">Reason</td><td style="padding:4px 0">${esc(r.reason)}</td></tr>`:''}
      ${b.status==='approved'?`<tr><td style="padding:4px 14px 4px 0;color:#777">Remaining allowance</td><td style="padding:4px 0">${remaining} of ${c.allowance} days</td></tr>`:''}
      </table>`;
    const recipients = [...new Set([c.email, ws.customerEmail, ...TEAM].filter(Boolean))];
    await mail(recipients, `Time off ${verb} — ${c.name} (${ws.company || 'Untapped'})`, emailWrap(`Time off ${verb}`, body, ws, process.env.SITE_URL));
    return json(200, { ok: true });
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
  if (action === 'submitTimeoff') {
    if (role !== 'candidate') return json(403, { error: 'only candidate submits' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.end))) return json(400, { error: 'bad dates' });
    const calc = workingDays(b.start, b.end, c.location);
    if (calc.days < 1) return json(400, { error: 'no working days in range' });
    c.timeoff = c.timeoff || [];
    const req = { id: uid(), start: b.start, end: b.end, reason: String(b.reason || '').slice(0, 300), status: 'pending', ts: new Date().toISOString() };
    c.timeoff.unshift(req); c.lastActivity = new Date().toISOString(); await save();
    const body = `<p style="font-size:15px;color:#333;margin:0 0 14px"><b>${esc(c.name)}</b> has requested time off and needs your approval.</p>
      <table style="border-collapse:collapse;font-size:14px;margin:0 0 8px">
      <tr><td style="padding:4px 14px 4px 0;color:#777">Dates</td><td style="padding:4px 0">${dateRange(req)}</td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#777">Working days</td><td style="padding:4px 0">${calc.days}</td></tr>
      ${req.reason?`<tr><td style="padding:4px 14px 4px 0;color:#777">Reason</td><td style="padding:4px 0">${esc(req.reason)}</td></tr>`:''}
      </table>`;
    await mail(ws.customerEmail, `Time-off request to approve — ${c.name}`, emailWrap('New time-off request', body, ws, process.env.SITE_URL));
    return json(200, { ok: true });
  }
  if (action === 'cancelTimeoff') {
    if (role !== 'candidate') return json(403, { error: 'forbidden' });
    const r = (c.timeoff || []).find(x => x.id === b.requestId);
    if (r && r.status !== 'pending') return json(400, { error: 'only pending requests can be cancelled' });
    c.timeoff = (c.timeoff || []).filter(x => x.id !== b.requestId); await save(); return json(200, { ok: true });
  }
  return json(400, { error: 'unknown action' });
};
