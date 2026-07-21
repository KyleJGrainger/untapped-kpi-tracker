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
const VA = 'pau@tryuntapped.com';
const DELIVERY = { 'South Africa': 'Ruan.Stander@tryuntapped.com', 'Philippines': 'Diana@tryuntapped.com' };
const KICKOFF = { 'South Africa': 'https://my.recruitwithatlas.com/tryuntappedcom/Ruan-Stander/Kickoff-Call', 'Philippines': 'https://my.recruitwithatlas.com/tryuntappedcom/Diana-Rose-Ariaso/Kickoff-Call' };
// Cost engine: total monthly £ the client sees = salary + service charge % + fixed EOR/payroll fee.
function costOf(salary, region) {
  const s = Math.max(0, Number(salary) || 0);
  if (region === 'South Africa') return { pct: 0.25, fee: 325, feeLabel: 'EOR', total: s * 1.25 + 325 };
  if (region === 'Philippines') return { pct: 0.35, fee: 150, feeLabel: 'Payroll', total: s * 1.35 + 150 };
  return { pct: 0, fee: 0, feeLabel: '', total: s };
}
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
  // Build the tracker link from the domain this request actually came from, so email
  // links keep working even if the Netlify site is renamed. Falls back to SITE_URL env.
  const H = event.headers || {};
  const reqHost = H['x-forwarded-host'] || H['host'] || '';
  const reqBase = reqHost ? `${H['x-forwarded-proto'] || 'https'}://${reqHost}` : (process.env.SITE_URL || '');
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
      customerPin: String(b.customerPin), adminPin: /^\d{4}$/.test(String(b.adminPin)) ? String(b.adminPin) : null,
      createdAt: new Date().toISOString(),
      commissions: [],
      onboarding: { required: false, retainerPerHire: Number(b.retainerPerHire) || 1000, hires: Number(b.hires) || 1, status: 'pending', signed: null, paid: null, questionnaireDone: false },
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

  // Public self-serve start: a prospect begins their own onboarding from the sales landing page.
  // Creates a workspace pre-set to the sign-terms → pay-deposit funnel. Deposit = £1000 (+ optional VAT).
  if (action === 'startSelfServe') {
    const company = String(b.company || '').trim();
    const email = String(b.email || '').trim();
    const contact = String(b.contact || '').trim();
    const region = (b.region === 'Philippines') ? 'Philippines' : (b.region === 'South Africa' ? 'South Africa' : '');
    if (company.length < 2) return json(400, { error: 'Please enter your company name.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Please enter a valid email.' });
    if (!region) return json(400, { error: 'Please choose a region.' });
    const pin = () => String(Math.floor(1000 + Math.random() * 9000));
    const wsId = uid();
    const ws = {
      id: wsId, company, customerEmail: email, contactName: contact,
      customerPin: pin(), adminPin: null, createdAt: new Date().toISOString(), commissions: [],
      onboarding: {
        required: true, selfServe: true, region,
        retainerPerHire: 1000, hires: 1, vat: !!b.vat, depositLabel: 'deposit',
        status: 'pending', signed: null, paid: null, questionnaireDone: false
      },
      candidates: []
    };
    await store.setJSON(wsId, ws);
    const total = 1000 * (ws.onboarding.vat ? 1.2 : 1);
    const body = `<p style="font-size:15px;color:#333">A new prospect started self-serve onboarding.</p>
      <p style="color:#555;font-size:14px"><b>${esc(company)}</b>${contact ? ' · ' + esc(contact) : ''}<br>${esc(email)} · ${esc(region)}<br>Deposit: £${total.toFixed(0)}${ws.onboarding.vat ? ' (inc VAT)' : ''}</p>
      <p style="color:#777;font-size:13px">They're now in the sign-terms → pay-deposit flow.</p>`;
    await mail(TEAM, `New self-serve signup — ${company}`, emailWrap('New self-serve signup', body, ws, reqBase));
    return json(200, { ok: true, wsId });
  }

  /* =====================  UNTAPPED CENTRAL ADMIN CONSOLE  =====================
   * Global, key-gated (separate from per-client PINs). Config lives in the
   * "__config" blob. Lets Untapped create clients, list them, and track MSAs.
   */
  const stageOf = (o) => {
    o = o || {};
    if (o.ddDone) return 'active';
    if (o.woDone) return 'directdebit';
    if (o.hired) return 'workorder';
    if (o.booked) return 'shortlist';
    if (o.questionnaireDone) return 'booked';
    if (o.paid) return 'questionnaire';
    if (o.signed) return 'paid';
    return 'sent';
  };
  if (action === 'adminStatus') {
    const cfg = await store.get('__config', { type: 'json' });
    const authed = !!(cfg && cfg.adminKey && String(b.adminKey || '') === String(cfg.adminKey));
    return json(200, { ok: true, setup: !!(cfg && cfg.adminKey), authed });
  }
  if (action === 'adminBootstrap') {
    const cfg = (await store.get('__config', { type: 'json' })) || {};
    if (cfg.adminKey) return json(403, { error: 'admin already set up' });
    if (!/^\d{4,8}$/.test(String(b.adminKey || ''))) return json(400, { error: 'admin PIN must be 4–8 digits' });
    cfg.adminKey = String(b.adminKey); await store.setJSON('__config', cfg);
    return json(200, { ok: true });
  }
  const adminAuthed = async () => {
    const cfg = await store.get('__config', { type: 'json' });
    return !!(cfg && cfg.adminKey && String(b.adminKey || '') === String(cfg.adminKey));
  };
  // Bulk wipe of client workspaces (keeps __config, rooms and CVs). Guarded + confirm required.
  if (action === 'adminClearAll') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    if (b.confirm !== 'DELETE') return json(400, { error: 'confirmation required' });
    const { blobs } = await store.list();
    let deleted = 0;
    for (const bl of blobs) {
      if (bl.key === '__config') continue;      // keep admin config
      if (bl.key.includes(':')) continue;        // keep room:* and cv:* blobs
      await store.delete(bl.key); deleted++;      // client workspaces only
    }
    return json(200, { ok: true, deleted });
  }
  if (action === 'adminList') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    const { blobs } = await store.list();
    const clients = [];
    for (const bl of blobs) {
      if (bl.key === '__config') continue;
      const w = await store.get(bl.key, { type: 'json' }); if (!w) continue;
      const o = w.onboarding || {};
      const per = Number(o.retainerPerHire) || 0, hires = Number(o.hires) || 1;
      const total = o.vat ? per * hires * 1.2 : per * hires;
      clients.push({
        id: w.id, company: w.company || '', customerEmail: w.customerEmail || '',
        region: o.region || null, retainerTotal: total, required: !!o.required, existingClient: !!o.existingClient,
        stage: o.required ? stageOf(o) : (o.existingClient ? 'active' : 'no-onboarding'),
        signed: o.signed || null, paid: o.paid || null, questionnaireDone: !!o.questionnaireDone,
        sentAt: o.sentAt || w.createdAt || null, createdAt: w.createdAt || null
      });
    }
    clients.sort((a, b2) => String(b2.sentAt || '').localeCompare(String(a.sentAt || '')));
    return json(200, { ok: true, clients });
  }
  // Export PH candidates' Wise payout rows in the EXACT Wise CSV column order.
  if (action === 'adminExportPayouts') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    const { blobs } = await store.list();
    const rows = [];
    for (const bl of blobs) {
      if (bl.key === '__config' || bl.key.includes(':')) continue;
      const w = await store.get(bl.key, { type: 'json' }); if (!w) continue;
      for (const c of (w.candidates || [])) {
        if (c.location === 'Philippines' && c.payout) {
          rows.push({
            recipientId: c.payout.recipientId || '', name: c.payout.name || c.name || '', recipientEmail: c.payout.email || '',
            recipientDetail: '', sourceCurrency: c.payout.sourceCurrency || 'GBP', targetCurrency: c.payout.targetCurrency || 'PHP',
            amountCurrency: c.payout.amountCurrency || 'source', amount: c.payout.amount || '', paymentReference: '', receiverType: 'PERSON',
            company: w.company || '', registeredAt: c.payout.registeredAt || null
          });
        }
      }
    }
    rows.sort((a, b2) => String(a.name).localeCompare(String(b2.name)));
    return json(200, { ok: true, rows });
  }
  // List PH payouts for the admin editor (includes the Work Order monthly salary to prefill the amount).
  if (action === 'adminListPayouts') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    const { blobs } = await store.list();
    const rows = [];
    for (const bl of blobs) {
      if (bl.key === '__config' || bl.key.includes(':')) continue;
      const w = await store.get(bl.key, { type: 'json' }); if (!w) continue;
      const wo = w.onboarding && w.onboarding.workOrder;
      const woSalary = wo && Number(wo.grossSalaryMonthly) ? Number(wo.grossSalaryMonthly) : null;
      for (const c of (w.candidates || [])) {
        if (c.location === 'Philippines' && c.payout) {
          rows.push({ wsId: w.id, candidateId: c.id, name: c.payout.name || c.name || '', email: c.payout.email || '', targetCurrency: c.payout.targetCurrency || 'PHP', amount: c.payout.amount || '', recipientId: c.payout.recipientId || '', woSalary, company: w.company || '' });
        }
      }
    }
    rows.sort((a, b2) => String(a.name).localeCompare(String(b2.name)));
    return json(200, { ok: true, rows });
  }
  // Admin sets/edits a PH candidate's Wise payout amount (plain number; blank allowed) and/or Wise recipient ID.
  if (action === 'adminSetPayoutAmount') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    const w = await store.get(b.wsId, { type: 'json' }); if (!w) return json(404, { error: 'client not found' });
    const c = (w.candidates || []).find(x => x.id === b.candidateId); if (!c || !c.payout) return json(404, { error: 'candidate/payout not found' });
    if (b.amount != null) {
      const amt = String(b.amount).trim();
      if (amt !== '' && !/^\d+(\.\d{1,2})?$/.test(amt)) return json(400, { error: 'Amount must be a plain number — no commas, no £.' });
      c.payout.amount = amt;
    }
    if (b.recipientId != null) c.payout.recipientId = String(b.recipientId).trim().slice(0, 100);
    await store.setJSON(b.wsId, w);
    return json(200, { ok: true });
  }
  if (action === 'adminCreateClient') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    if (!String(b.company || '').trim()) return json(400, { error: 'company name required' });
    const existing = !!b.existing;
    const region = ['Philippines', 'South Africa'].includes(b.region) ? b.region : null;
    if (!existing && !region) return json(400, { error: 'choose a region' });
    const wsId = uid();
    const gen = () => String(Math.floor(1000 + Math.random() * 9000));
    const clientPin = gen();
    const mkCand = (name, email, role) => ({
      id: uid(), name: String(name || 'Team member').trim(), role: String(role || ''), email: String(email || ''),
      location: region || 'South Africa', allowance: 20, timeoff: [], candidatePin: gen(),
      createdAt: new Date().toISOString(), kpis: { daily: [], weekly: [], monthly: [] },
      logs: { daily: {}, weekly: {}, monthly: {} }, pulse: {}, blockers: [], kudos: [], lastActivity: null
    });
    let candidates, onboarding;
    if (existing) {
      // Already-onboarded client: skip the funnel entirely, instant dashboard access.
      const tm = Array.isArray(b.teamMembers) ? b.teamMembers : [];
      candidates = tm.filter(m => m && String(m.name || '').trim()).map(m => mkCand(m.name, m.email, m.role));
      onboarding = { required: false, existingClient: true, region: region || null, status: 'complete' };
    } else {
      candidates = [mkCand(b.candidate || 'First hire', '', '')];
      onboarding = {
        required: true, retainerPerHire: Math.max(0, Number(b.retainerPerHire) || 1000),
        hires: Math.max(1, Math.round(Number(b.hires) || 1)), vat: !!b.vat, region,
        status: 'pending', signed: null, paid: null, questionnaireDone: false,
        booked: false, hired: false, woDone: false, ddDone: false, sentAt: new Date().toISOString()
      };
    }
    const ws = {
      id: wsId, company: String(b.company).trim(), customerEmail: b.customerEmail || '',
      customerPin: clientPin, adminPin: null, createdAt: new Date().toISOString(), commissions: [],
      onboarding, candidates
    };
    await store.setJSON(wsId, ws);
    return json(200, { ok: true, wsId, clientPin, existing, candidatePin: candidates[0] ? candidates[0].candidatePin : null, team: candidates.map(c => ({ name: c.name, candidatePin: c.candidatePin })) });
  }
  if (action === 'adminDeleteClient') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    const w = await store.get(b.wsId, { type: 'json' });
    if (w && w.onboarding && Array.isArray(w.onboarding.shortlist)) {
      for (const c of w.onboarding.shortlist) { try { await store.delete('cv:' + b.wsId + ':' + c.id); } catch (e) {} }
    }
    await store.delete(b.wsId);
    return json(200, { ok: true, deleted: true });
  }
  // ---- Admin: manage a specific client's candidate shortlist ----
  if (action === 'adminGetClient' || action === 'adminAddCandidate' || action === 'adminUpdateCandidate'
      || action === 'adminRemoveCandidate' || action === 'adminUploadCV' || action === 'adminSetHired' || action === 'adminSaveWorkOrder'
      || action === 'adminCountersignMSA' || action === 'adminCountersignWO' || action === 'adminLinkRoom' || action === 'adminMarkKickoffAttended') {
    if (!(await adminAuthed())) return json(401, { error: 'admin auth required' });
    const w = await store.get(b.wsId, { type: 'json' }); if (!w) return json(404, { error: 'client not found' });
    w.onboarding = w.onboarding || {}; if (!Array.isArray(w.onboarding.shortlist)) w.onboarding.shortlist = [];
    const region = w.onboarding.region;
    const saveW = async () => { await store.setJSON(b.wsId, w); };
    if (action === 'adminGetClient') {
      const o = w.onboarding;
      return json(200, { ok: true, client: {
        id: w.id, company: w.company, region, customerEmail: w.customerEmail || '',
        clientPin: w.customerPin || '', roomId: w.roomId || null, existingClient: !!o.existingClient,
        // full team-member list with PINs — revealed only once the Work Order is signed
        team: o.woDone ? (w.candidates || []).map(c => ({ id: c.id, name: c.name || 'Team member', candidatePin: c.candidatePin || '' })) : null,
        teamCount: (w.candidates || []).length,
        retainerPerHire: o.retainerPerHire, hires: o.hires, vat: !!o.vat,
        signed: o.signed || null, paid: o.paid || null, questionnaireDone: !!o.questionnaireDone,
        booked: o.booked || null, kickoffAttended: o.kickoffAttended || null, hired: o.hired || null, woDone: o.woDone || null, ddDone: o.ddDone || null,
        msaCountersign: o.msaCountersign || null, workOrder: o.workOrder || null,
        shortlist: (o.shortlist || []).map(c => { const k = costOf(c.salary, region); return {
          id: c.id, name: c.name, commentary: c.commentary || '', salary: Number(c.salary) || 0, hasCV: !!c.hasCV,
          pct: k.pct, fee: k.fee, feeLabel: k.feeLabel, totalCost: k.total, requests: c.requests || [] }; })
      }});
    }
    if (action === 'adminLinkRoom') {
      w.roomId = b.roomId ? String(b.roomId) : null;
      await saveW(); return json(200, { ok: true, roomId: w.roomId });
    }
    if (action === 'adminMarkKickoffAttended') {
      w.onboarding.kickoffAttended = { ts: new Date().toISOString() };
      await saveW(); return json(200, { ok: true });
    }
    if (action === 'adminSetHired') {
      const c = w.onboarding.shortlist.find(x => x.id === b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
      w.onboarding.hired = { candidateId: c.id, name: c.name, salary: Number(c.salary) || 0, ts: new Date().toISOString() };
      // seed the Work Order's Untapped-side fields from the hire
      w.onboarding.workOrder = Object.assign({ employeeName: c.name, jobTitle: '', startDate: '', grossSalaryMonthly: Number(c.salary) || 0,
        annualLeaveDays: 15, sickLeaveDays: 12, commissionDetails: '', jobDescription: '', noticePeriod: '1 Calendar Month', costNote: '',
        client: {}, signed: null }, w.onboarding.workOrder || {});
      await saveW();
      return json(200, { ok: true });
    }
    if (action === 'adminSaveWorkOrder') {
      w.onboarding.workOrder = w.onboarding.workOrder || { client: {}, signed: null };
      const f = b.wo || {}; const wo = w.onboarding.workOrder;
      ['employeeName','jobTitle','startDate','commissionDetails','jobDescription','noticePeriod','costNote'].forEach(k => { if (f[k] != null) wo[k] = String(f[k]); });
      if (f.grossSalaryMonthly != null) wo.grossSalaryMonthly = Math.max(0, Number(f.grossSalaryMonthly) || 0);
      if (f.annualLeaveDays != null) wo.annualLeaveDays = Math.max(0, Number(f.annualLeaveDays) || 0);
      if (f.sickLeaveDays != null) wo.sickLeaveDays = Math.max(0, Number(f.sickLeaveDays) || 0);
      await saveW(); return json(200, { ok: true });
    }
    if (action === 'adminCountersignMSA') {
      const name = String(b.name || '').trim(); if (name.length < 2) return json(400, { error: 'enter your name' });
      w.onboarding.msaCountersign = { name, title: String(b.title || 'CEO').slice(0, 80), ts: new Date().toISOString() };
      await saveW(); return json(200, { ok: true });
    }
    if (action === 'adminCountersignWO') {
      if (!w.onboarding.workOrder) return json(400, { error: 'no work order yet' });
      const name = String(b.name || '').trim(); if (name.length < 2) return json(400, { error: 'enter your name' });
      w.onboarding.workOrder.untappedSigned = { name, title: String(b.title || 'CEO').slice(0, 80), ts: new Date().toISOString() };
      await saveW(); return json(200, { ok: true });
    }
    if (action === 'adminAddCandidate') {
      const c = { id: uid(), name: String(b.name || 'Candidate').trim(), commentary: String(b.commentary || '').slice(0, 600), salary: Math.max(0, Number(b.salary) || 0), hasCV: false, requests: [], ts: new Date().toISOString() };
      w.onboarding.shortlist.push(c); await saveW();
      return json(200, { ok: true, candidateId: c.id });
    }
    if (action === 'adminUpdateCandidate') {
      const c = w.onboarding.shortlist.find(x => x.id === b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
      if (b.name != null) c.name = String(b.name).trim();
      if (b.commentary != null) c.commentary = String(b.commentary).slice(0, 600);
      if (b.salary != null) c.salary = Math.max(0, Number(b.salary) || 0);
      await saveW(); return json(200, { ok: true });
    }
    if (action === 'adminRemoveCandidate') {
      w.onboarding.shortlist = w.onboarding.shortlist.filter(x => x.id !== b.candidateId);
      await saveW(); try { await store.delete('cv:' + b.wsId + ':' + b.candidateId); } catch (e) {}
      return json(200, { ok: true });
    }
    if (action === 'adminUploadCV') {
      const c = w.onboarding.shortlist.find(x => x.id === b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
      const data = String(b.dataBase64 || '');
      if (!data || data.length > 8 * 1024 * 1024) return json(400, { error: 'missing or oversized file (max ~6MB)' });
      await store.set('cv:' + b.wsId + ':' + b.candidateId, data);
      c.hasCV = true; await saveW();
      return json(200, { ok: true });
    }
  }

  const wsId = b.wsId; if (!wsId) return json(400, { error: 'missing wsId' });
  const ws = await store.get(wsId, { type: 'json' });
  if (!ws) return json(404, { error: 'not found' });
  if (!ws.onboarding) ws.onboarding = {};
  { // normalise/migrate onboarding shape (older records used a single `retainer`)
    const o = ws.onboarding;
    if (o.required == null) o.required = false;
    if (o.retainerPerHire == null) o.retainerPerHire = Number(o.retainer) || 1000;
    if (o.hires == null) o.hires = 1;
    if (o.status == null) o.status = 'pending';
    if (o.signed === undefined) o.signed = null;
    if (o.paid === undefined) o.paid = null;
    if (o.questionnaireDone == null) o.questionnaireDone = false;
    if (o.region === undefined) o.region = null; // 'Philippines' | 'South Africa'
    if (o.vat == null) o.vat = false; // add 20% VAT
    if (o.booked === undefined) o.booked = null;   // kick-off call booked
    if (o.hired === undefined) o.hired = null;     // client hired a candidate
    if (o.woDone === undefined) o.woDone = null;   // Work Order complete
    if (o.ddDone === undefined) o.ddDone = null;   // Direct Debit set up
    if (!Array.isArray(o.shortlist)) o.shortlist = []; // presented candidates
  }

  /* ---- PUBLIC onboarding funnel actions (no PIN — this layer sits in front of PIN entry) ---- */
  const obSave = async () => { await store.setJSON(wsId, ws); };
  const obBase = () => Math.max(0, (Number(ws.onboarding.retainerPerHire) || 0) * (Number(ws.onboarding.hires) || 1));
  const obTotal = () => ws.onboarding.vat ? Math.round(obBase() * 1.2 * 100) / 100 : obBase();
  const obPublic = () => ({
    required: !!ws.onboarding.required, retainerPerHire: Number(ws.onboarding.retainerPerHire) || 1000,
    hires: Number(ws.onboarding.hires) || 1, retainerBase: obBase(), vat: !!ws.onboarding.vat, retainerTotal: obTotal(),
    region: ws.onboarding.region || null, kickoffUrl: KICKOFF[ws.onboarding.region] || '',
    status: ws.onboarding.status || 'pending', company: ws.company || '',
    roomId: ws.roomId || null, selfServe: !!ws.onboarding.selfServe,
    signed: !!ws.onboarding.signed, paid: !!ws.onboarding.paid, questionnaireDone: !!ws.onboarding.questionnaireDone,
    booked: !!ws.onboarding.booked, hired: !!ws.onboarding.hired, woDone: !!ws.onboarding.woDone, ddDone: !!ws.onboarding.ddDone,
    hiredName: (ws.onboarding.hired || {}).name || '',
    signedCompany: (ws.onboarding.signed || {}).company || null,
    // Work Order — the Untapped-filled parts the client reviews before adding their own details + signing
    workOrder: ws.onboarding.workOrder ? {
      employeeName: ws.onboarding.workOrder.employeeName || '', jobTitle: ws.onboarding.workOrder.jobTitle || '',
      startDate: ws.onboarding.workOrder.startDate || '', grossSalaryMonthly: Number(ws.onboarding.workOrder.grossSalaryMonthly) || 0,
      annualLeaveDays: ws.onboarding.workOrder.annualLeaveDays, sickLeaveDays: ws.onboarding.workOrder.sickLeaveDays,
      commissionDetails: ws.onboarding.workOrder.commissionDetails || '', jobDescription: ws.onboarding.workOrder.jobDescription || '',
      noticePeriod: ws.onboarding.workOrder.noticePeriod || '', costNote: ws.onboarding.workOrder.costNote || '',
      signed: !!(ws.onboarding.workOrder.signed)
    } : null,
    // dashboard PIN is revealed ONLY once the whole journey is complete (Direct Debit done)
    clientPin: ws.onboarding.ddDone ? ws.customerPin : undefined,
    // client-safe shortlist — total cost only, never the salary or the workings
    shortlist: (ws.onboarding.shortlist || []).map(c => ({
      id: c.id, name: c.name || '', commentary: c.commentary || '', hasCV: !!c.hasCV,
      totalCost: costOf(c.salary, ws.onboarding.region).total, requests: c.requests || []
    }))
  });
  const obRecompute = () => {
    const o = ws.onboarding;
    o.status = o.ddDone ? 'complete' : o.woDone ? 'directdebit' : o.hired ? 'workorder' : o.booked ? 'shortlist'
      : o.questionnaireDone ? 'booked' : o.paid ? 'questionnaire' : o.signed ? 'paid' : 'pending';
  };
  if (action === 'onboardingStatus') {
    return json(200, { ok: true, onboarding: obPublic() });
  }
  if (action === 'submitSignature') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    const name = String(b.name || '').trim();
    if (name.length < 2) return json(400, { error: 'enter your full name' });
    const co = b.company || {};
    const companyName = String(co.name || '').trim(), regNumber = String(co.regNumber || '').trim();
    if (companyName.length < 2) return json(400, { error: 'enter your company name' });
    if (regNumber.length < 1) return json(400, { error: 'enter your company registration number' });
    const company = { name: companyName, regNumber, address: String(co.address || '').slice(0, 400) };
    const ip = (H['x-nf-client-connection-ip'] || (H['x-forwarded-for'] || '').split(',')[0] || '').trim();
    ws.onboarding.signed = { name, company, ip, ts: new Date().toISOString() };
    obRecompute(); await obSave();
    const sBody = `<p style="font-size:15px;color:#333"><b>${esc(name)}</b> has signed the terms for <b>${esc(companyName)}</b>.</p><p style="color:#777;font-size:13px">Company: ${esc(companyName)} · Reg ${esc(regNumber)}${company.address ? '<br>' + esc(company.address) : ''}<br>Signed ${new Date().toLocaleString('en-GB')} · IP ${esc(ip || 'n/a')}. Awaiting retainer payment (£${obTotal().toFixed(0)}).</p>`;
    await mail(TEAM, `Terms signed — ${companyName}`, emailWrap('Terms signed', sBody, ws, reqBase));
    return json(200, { ok: true, onboarding: obPublic() });
  }
  if (action === 'createCheckout') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    if (!ws.onboarding.signed) return json(400, { error: 'please sign the terms first' });
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return json(200, { ok: false, error: 'payment not configured' });
    const amount = Math.round(obTotal() * 100);
    const base = reqBase.replace(/\/$/, '');
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${base}/?w=${wsId}&ob=paid&sid={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${base}/?w=${wsId}&ob=cancel`);
    params.append('client_reference_id', wsId);
    params.append('metadata[wsId]', wsId);
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'gbp');
    params.append('line_items[0][price_data][unit_amount]', String(amount));
    params.append('line_items[0][price_data][product_data][name]', `Retainer — ${ws.company || 'Untapped'}`);
    try {
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
      });
      const sess = await r.json();
      if (!r.ok) return json(200, { ok: false, error: (sess.error && sess.error.message) || 'Stripe error' });
      return json(200, { ok: true, url: sess.url });
    } catch (e) { return json(200, { ok: false, error: e.message }); }
  }
  if (action === 'verifyCheckout') {
    if (ws.onboarding.paid) { obRecompute(); return json(200, { ok: true, onboarding: obPublic() }); }
    const key = process.env.STRIPE_SECRET_KEY;
    const sid = String(b.sessionId || '');
    if (!key || !sid) return json(200, { ok: false, error: 'cannot verify' });
    try {
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sid), { headers: { Authorization: `Bearer ${key}` } });
      const sess = await r.json();
      if (r.ok && sess.payment_status === 'paid' && (sess.metadata && sess.metadata.wsId) === wsId) {
        ws.onboarding.paid = { amount: (sess.amount_total || 0) / 100, sessionId: sid, ts: new Date().toISOString() };
        obRecompute(); await obSave();
        const pBody = `<p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> has paid their retainer of <b>£${((sess.amount_total || 0) / 100).toFixed(2)}</b>.</p><p style="color:#777;font-size:13px">Signed by ${esc((ws.onboarding.signed || {}).name || '—')}. They now continue to the kick-off questionnaire.</p>`;
        await mail(TEAM, `Retainer paid — ${ws.company || 'client'} · £${((sess.amount_total || 0) / 100).toFixed(2)}`, emailWrap('Retainer paid', pBody, ws, reqBase));
      }
      return json(200, { ok: true, onboarding: obPublic() });
    } catch (e) { return json(200, { ok: false, error: e.message }); }
  }
  if (action === 'markQuestionnaireDone') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    ws.onboarding.questionnaireDone = true; ws.onboarding.questionnaireTs = new Date().toISOString();
    obRecompute(); await obSave();
    return json(200, { ok: true, onboarding: obPublic() });
  }
  if (action === 'markBooked') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    if (!ws.onboarding.questionnaireDone) return json(400, { error: 'complete the questionnaire first' });
    ws.onboarding.booked = { ts: new Date().toISOString() };
    obRecompute(); await obSave();
    const region = ws.onboarding.region;
    const body = `<p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> has booked their kick-off call.</p><p style="color:#777;font-size:13px">Region: ${esc(region || '—')}. Time to prepare their candidate shortlist.</p>`;
    await mail([...TEAM, DELIVERY[region]].filter(Boolean), `Kick-off booked — ${ws.company || 'client'}`, emailWrap('Kick-off call booked', body, ws, reqBase));
    return json(200, { ok: true, onboarding: obPublic() });
  }
  if (action === 'shortlistAction') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    const c = (ws.onboarding.shortlist || []).find(x => x.id === b.candidateId);
    if (!c) return json(404, { error: 'candidate not found' });
    const acts = { interview: 'Interview requested', second: '2nd interview requested', offer: 'Offer requested' };
    if (!acts[b.act]) return json(400, { error: 'unknown action' });
    c.requests = c.requests || [];
    c.requests.push({ act: b.act, label: acts[b.act], ts: new Date().toISOString() });
    await obSave();
    const region = ws.onboarding.region;
    const to = [...TEAM, DELIVERY[region]].filter(Boolean);
    const body = `<p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> — <b>${esc(acts[b.act])}</b> for candidate <b>${esc(c.name || '—')}</b>.</p><p style="color:#777;font-size:13px">Region: ${esc(region || '—')}.</p>`;
    await mail(to, `${acts[b.act]} — ${c.name || 'candidate'} (${ws.company || 'client'})`, emailWrap(acts[b.act], body, ws, reqBase));
    return json(200, { ok: true, onboarding: obPublic() });
  }
  if (action === 'requestCheckin') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    const region = ws.onboarding.region;
    const to = [DELIVERY[region], VA].filter(Boolean);
    if (!to.length) return json(400, { error: 'no delivery lead for region' });
    const note = String(b.note || '').slice(0, 500);
    const body = `<p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> has requested a check-in with the delivery lead.</p>${note ? `<p style="color:#333">“${esc(note)}”</p>` : ''}<p style="color:#777;font-size:13px">Region: ${esc(region || '—')}.</p>`;
    await mail(to, `Check-in requested — ${ws.company || 'client'} (${region || '—'})`, emailWrap('Check-in requested', body, ws, reqBase));
    return json(200, { ok: true });
  }
  if (action === 'submitWorkOrder') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    if (!ws.onboarding.hired) return json(400, { error: 'not at Work Order stage yet' });
    const name = String(b.name || '').trim(); if (name.length < 2) return json(400, { error: 'enter your full name' });
    const cf = b.client || {};
    const wo = ws.onboarding.workOrder = ws.onboarding.workOrder || { client: {}, signed: null };
    wo.client = {
      companyName: String(cf.companyName || '').slice(0, 200), companyAddress: String(cf.companyAddress || '').slice(0, 400),
      companyRegNumber: String(cf.companyRegNumber || '').slice(0, 80), contactName: String(cf.contactName || '').slice(0, 120),
      hiringManagerEmail: String(cf.hiringManagerEmail || '').slice(0, 160), accountsEmail: String(cf.accountsEmail || '').slice(0, 160)
    };
    const ip = (H['x-nf-client-connection-ip'] || (H['x-forwarded-for'] || '').split(',')[0] || '').trim();
    wo.signed = { name, ip, ts: new Date().toISOString() };
    ws.onboarding.woDone = { ts: new Date().toISOString() };
    obRecompute(); await obSave();
    const body = `<p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> has completed &amp; signed their Work Order for <b>${esc(wo.employeeName || 'the hire')}</b>.</p><p style="color:#777;font-size:13px">Signed by ${esc(name)}. Next step for them: Direct Debit.</p>`;
    await mail([...TEAM, DELIVERY[ws.onboarding.region]].filter(Boolean), `Work Order signed — ${ws.company || 'client'}`, emailWrap('Work Order signed', body, ws, reqBase));
    return json(200, { ok: true, onboarding: obPublic() });
  }
  if (action === 'markDD') {
    if (!ws.onboarding.required) return json(400, { error: 'onboarding not enabled' });
    if (!ws.onboarding.woDone) return json(400, { error: 'complete the Work Order first' });
    ws.onboarding.ddDone = { ts: new Date().toISOString() };
    obRecompute(); await obSave();
    const body = `<p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> has set up their Direct Debit — <b>onboarding complete</b>. Their dashboard is now unlocked.</p>`;
    await mail([...TEAM, DELIVERY[ws.onboarding.region]].filter(Boolean), `Onboarding complete — ${ws.company || 'client'}`, emailWrap('Onboarding complete', body, ws, reqBase));
    return json(200, { ok: true, onboarding: obPublic() });
  }

  const isAdmin = ws.adminPin && String(b.pin) === String(ws.adminPin);
  const isCustomer = !isAdmin && String(b.pin) === ws.customerPin;
  const candByPin = (ws.candidates || []).find(c => c.candidatePin === String(b.pin));
  if (!isAdmin && !isCustomer && !candByPin) return json(401, { error: 'incorrect pin' });
  const isManager = isAdmin || isCustomer; // both can run the customer-side management actions
  const role = isAdmin ? 'admin' : isCustomer ? 'customer' : 'candidate';

  // Bootstrap / change the Untapped admin PIN. If none set yet, the customer can set one (one-time);
  // once set, only the admin can change it. This keeps onboarding config out of clients' hands.
  if (action === 'setAdminPin') {
    if (ws.adminPin ? !isAdmin : !isCustomer) return json(403, { error: 'forbidden' });
    if (!/^\d{4}$/.test(String(b.newAdminPin))) return json(400, { error: 'PIN must be 4 digits' });
    if (String(b.newAdminPin) === ws.customerPin) return json(400, { error: 'Admin PIN must differ from the client PIN' });
    ws.adminPin = String(b.newAdminPin); await obSave();
    return json(200, { ok: true });
  }

  // GET — admin/customer see whole workspace; candidate sees only their own record
  if (action === 'get') {
    if (isManager) {
      const { customerPin, ...safe } = ws; // keep candidate pins so manager can share links
      if (!isAdmin) delete safe.adminPin; // never expose the admin PIN to a client
      safe.hasAdminPin = !!ws.adminPin;
      return json(200, { ok: true, role, workspace: safe });
    }
    const { candidatePin, ...c } = candByPin;
    return json(200, { ok: true, role, company: ws.company, candidate: c });
  }

  const save = async () => { await store.setJSON(wsId, ws); };

  if (action === 'addCandidate') {
    if (!isManager) return json(403, { error: 'forbidden' });
    if (!/^\d{4}$/.test(String(b.candidatePin))) return json(400, { error: 'PIN must be 4 digits' });
    const c = { id: uid(), name: b.name || 'Candidate', role: b.role || '', candidatePin: String(b.candidatePin),
      email: b.email || '', location: b.location || '', allowance: Number(b.allowance) || 20, timeoff: [],
      createdAt: new Date().toISOString(), kpis: { daily: [], weekly: [], monthly: [] },
      logs: { daily: {}, weekly: {}, monthly: {} }, pulse: {}, blockers: [], kudos: [], lastActivity: null };
    ws.candidates.push(c); await save();
    return json(200, { ok: true, candidateId: c.id });
  }
  if (action === 'editCandidate') {
    if (!isManager) return json(403, { error: 'forbidden' });
    const c = findCandidate(ws, b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
    if (b.name != null) c.name = String(b.name);
    if (b.role != null) c.role = String(b.role);
    if (b.email != null) c.email = String(b.email);
    if (b.location != null) c.location = String(b.location);
    if (b.allowance != null) c.allowance = Math.max(0, Number(b.allowance) || 0);
    await save(); return json(200, { ok: true });
  }
  if (action === 'setOnboardingConfig') {
    if (!isAdmin) return json(403, { error: 'admin only' });
    if (b.required != null) ws.onboarding.required = !!b.required;
    if (b.retainerPerHire != null) ws.onboarding.retainerPerHire = Math.max(0, Number(b.retainerPerHire) || 0);
    if (b.hires != null) ws.onboarding.hires = Math.max(1, Math.round(Number(b.hires) || 1));
    if (b.vat != null) ws.onboarding.vat = !!b.vat;
    if (b.region !== undefined) ws.onboarding.region = ['Philippines', 'South Africa'].includes(b.region) ? b.region : null;
    obRecompute(); await save();
    return json(200, { ok: true, onboarding: { ...ws.onboarding, retainerTotal: obTotal() } });
  }
  if (action === 'resetOnboarding') {
    if (!isAdmin) return json(403, { error: 'admin only' });
    ws.onboarding.signed = null; ws.onboarding.paid = null; ws.onboarding.questionnaireDone = false; ws.onboarding.status = 'pending';
    await save(); return json(200, { ok: true });
  }
  if (action === 'deleteWorkspace') {
    if (!isAdmin) return json(403, { error: 'admin only' });
    if (String(b.confirm) !== 'DELETE') return json(400, { error: 'confirmation required' });
    await store.delete(wsId);
    return json(200, { ok: true, deleted: true });
  }
  if (action === 'addCommission') {
    if (!isManager) return json(403, { error: 'forbidden' });
    ws.commissions = ws.commissions || [];
    const month = /^\d{4}-\d{2}$/.test(String(b.month)) ? b.month : new Date().toISOString().slice(0, 7);
    const entry = { id: uid(), candidateId: b.candidateId || '', candidateName: (findCandidate(ws, b.candidateId) || {}).name || '', amount: Math.max(0, Number(b.amount) || 0), type: b.type === 'Bonus' ? 'Bonus' : 'Commission', note: String(b.note || '').slice(0, 400), month, ts: new Date().toISOString() };
    ws.commissions.unshift(entry);
    await save();
    const monthLbl = new Date(month + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const body = `<p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> just logged a ${esc(entry.type.toLowerCase())} for <b>${esc(entry.candidateName || '—')}</b>.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:8px">
        <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#777">Amount</td><td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:700">£${entry.amount.toFixed(2)}</td></tr>
        <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#777">Type</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(entry.type)}</td></tr>
        <tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#777">For month</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(monthLbl)}</td></tr>
        ${entry.note ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#777">Note</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(entry.note)}</td></tr>` : ''}
      </table>`;
    await mail(TEAM, `New ${entry.type.toLowerCase()} logged — ${ws.company || 'client'} · £${entry.amount.toFixed(2)}`, emailWrap('New commission logged', body, ws, reqBase));
    return json(200, { ok: true });
  }
  if (action === 'deleteCommission') {
    if (!isManager) return json(403, { error: 'forbidden' });
    ws.commissions = (ws.commissions || []).filter(x => x.id !== b.commissionId);
    await save(); return json(200, { ok: true });
  }
  if (action === 'decideTimeoff') {
    if (!isManager) return json(403, { error: 'forbidden' });
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
    await mail(recipients, `Time off ${verb} — ${c.name} (${ws.company || 'Untapped'})`, emailWrap(`Time off ${verb}`, body, ws, reqBase));
    return json(200, { ok: true });
  }
  if (action === 'saveKpis') {
    if (!isManager) return json(403, { error: 'forbidden' });
    const c = findCandidate(ws, b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
    if (b.kpis) c.kpis = b.kpis; await save(); return json(200, { ok: true });
  }
  if (action === 'addKudos') {
    if (!isManager) return json(403, { error: 'forbidden' });
    const c = findCandidate(ws, b.candidateId); if (!c) return json(404, { error: 'candidate not found' });
    c.kudos = c.kudos || []; c.kudos.unshift({ id: uid(), text: String(b.text || '').slice(0, 500), ts: new Date().toISOString() });
    await save(); return json(200, { ok: true });
  }
  if (action === 'digestNow') {
    if (!isManager) return json(403, { error: 'forbidden' });
    const { RESEND_API_KEY, FROM_EMAIL } = process.env;
    if (!RESEND_API_KEY || !FROM_EMAIL || !ws.customerEmail) return json(200, { ok: false, note: 'email not configured' });
    try { await sendEmail(RESEND_API_KEY, { from: FROM_EMAIL, to: [ws.customerEmail], subject: `Weekly update — ${ws.company || 'your team'}`, html: digestHTML(ws, reqBase) }); return json(200, { ok: true }); }
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
    c.blockers = c.blockers || []; const bl = { id: uid(), text: String(b.text || '').slice(0, 600), ts: new Date().toISOString(), resolved: false }; c.blockers.unshift(bl);
    c.lastActivity = new Date().toISOString(); await save();
    const body = `<p style="font-size:15px;color:#333;margin:0 0 10px"><b>${esc(c.name)}</b> has raised a blocker that needs your attention.</p><p style="color:#333;font-size:14px">${esc(bl.text)}</p>`;
    await mail(ws.customerEmail, `Blocker raised — ${c.name} (${ws.company || 'Untapped'})`, emailWrap('New blocker', body, ws, reqBase));
    return json(200, { ok: true });
  }
  if (action === 'resolveBlocker') {
    const bl = (c.blockers || []).find(x => x.id === b.blockerId); if (bl) bl.resolved = true; await save(); return json(200, { ok: true });
  }
  // PH payroll: candidate registers their Wise payout details (first-login gate). Locked fields: source=GBP, amountCurrency=source.
  if (action === 'savePayout') {
    if (role !== 'candidate') return json(403, { error: 'forbidden' });
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim();
    const target = String(b.targetCurrency || '').toUpperCase();
    if (name.length < 2) return json(400, { error: 'Enter your full name (must match your Wise account).' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Enter a valid email.' });
    if (!['PHP', 'GBP'].includes(target)) return json(400, { error: 'Choose a target currency.' });
    const prevPayout = c.payout || {};
    c.payout = { name, email, sourceCurrency: 'GBP', targetCurrency: target, amountCurrency: 'source', amount: prevPayout.amount || '', receiverType: 'PERSON', registeredAt: prevPayout.registeredAt || new Date().toISOString() };
    c.lastActivity = new Date().toISOString(); await save();
    const body = `<p style="font-size:15px;color:#333;margin:0 0 12px"><b>${esc(name)}</b> has registered their Wise payment details.</p>
      <table style="border-collapse:collapse;font-size:14px;margin:0 0 8px">
      <tr><td style="padding:4px 16px 4px 0;color:#777">Name</td><td style="padding:4px 0">${esc(name)}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#777">Email</td><td style="padding:4px 0">${esc(email)}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#777">Source currency</td><td style="padding:4px 0">GBP</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#777">Target currency</td><td style="padding:4px 0">${esc(target)}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#777">Amount currency</td><td style="padding:4px 0">source</td></tr>
      </table>
      <p style="color:#777;font-size:13px;margin:0 0 6px">Amount will be set by Untapped from the Work Order before payment.</p>
      <p style="color:#777;font-size:13px">Company: ${esc(ws.company || '—')}</p>`;
    await mail(['Nina@tryuntapped.com', 'finance@createandadapt.com'], `Wise details registered — ${name} (${ws.company || 'Untapped'})`, emailWrap('Wise payment details', body, ws, reqBase));
    return json(200, { ok: true });
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
    await mail(ws.customerEmail, `Time-off request to approve — ${c.name}`, emailWrap('New time-off request', body, ws, reqBase));
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
