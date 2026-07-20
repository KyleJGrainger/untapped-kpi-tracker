/* Untapped — Client Collaboration Room API.
 * A branded, per-role client room that presents an Atlas-seeded shortlist, tracks
 * client engagement, captures client actions/comments, and notifies the delivery team.
 *
 * Storage: Netlify Blobs, one JSON blob per room at key  room:<roomId>.
 * Rooms are seeded from Atlas by an agent/scheduled pull via the roomUpsert action
 * (guarded by the global admin key in __config). The pilot room is embedded below so
 * the page works the moment this deploys, before the scheduled sync is wired.
 *
 * Env: RESEND_API_KEY, FROM_EMAIL (team notices), SLACK_WEBHOOK_URL (optional),
 *      BLOBS_SITE_ID + NETLIFY_BLOBS_TOKEN (storage), SITE_URL (fallback link).
 * NOTE: read-only vs Atlas — client actions here notify the team + persist in the room;
 * the matching Atlas move is made by the team until write-API access exists.
 */
const json = (s, o) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const now = () => new Date().toISOString();

const TEAM = ['kyle@tryuntapped.com', 'Nina@tryuntapped.com', 'pau@tryuntapped.com'];

async function sendEmail(apiKey, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
}
async function mail(to, subject, html) {
  const { RESEND_API_KEY, FROM_EMAIL } = process.env;
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!RESEND_API_KEY || !FROM_EMAIL || !list.length) return;
  try { await sendEmail(RESEND_API_KEY, { from: FROM_EMAIL, to: list, subject, html }); } catch (e) {}
}
async function slack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); } catch (e) {}
}
function emailWrap(heading, bodyHtml, link) {
  return `<!doctype html><html><body style="margin:0;background:#fbf8fd;font-family:Helvetica,Arial,sans-serif;color:#1a1424">
    <div style="background:#101820;padding:20px 28px"><span style="color:#fff;font-size:20px;font-weight:700">untapped</span></div>
    <div style="height:4px;background:linear-gradient(90deg,#FFC600,#FF6900,#DA291C)"></div>
    <div style="max-width:600px;margin:0 auto;padding:28px">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:23px;margin:0 0 14px">${esc(heading)}</h1>
      ${bodyHtml}
      ${link ? `<p style="margin-top:22px"><a href="${link}" style="background:#101820;color:#fff;text-decoration:none;padding:11px 20px;border-radius:4px;font-size:14px">Open the room →</a></p>` : ''}
      <p style="color:#999;font-size:12px;margin-top:24px">Untapped · tryuntapped.com — collaboration room</p>
    </div></body></html>`;
}

// ---- Pilot room, seeded from real Atlas data (ninetwenty · SA Delivery Consultant) ----
const CLIENT_STAGES = [['presented', 'Presented'], ['interview', 'Client Interview'], ['second', '2nd Interview'], ['offer', 'Offer'], ['hired', 'Hired']];
const SEED = {
  id: 'ninetwenty-delivery',
  atlasProjectId: '4d2ad38d-8b78-48d2-b1cb-74d8073b7be2',
  role: 'SA — Delivery Consultant', region: 'South Africa',
  client: { name: 'ninetwenty', contactName: 'Chris Lowden' },
  owner: 'Ruan Stander',
  hub: {
    jd: 'Delivery Consultant (Data & AI) — full-time, SA-based, UK hours. Sourcing, screening and delivery across tech/change mandates.',
    fees: 'Packaged monthly cost per associate (salary + Untapped service charge + EOR/payroll). £1,500 set-up fee, fully refundable if we fail to deliver.',
    msaStatus: 'MSA signed 12 Jun 2026 · counter-signed by Untapped.',
    process: '1) Review shortlist · 2) Request interview (Calendly) · 3) 2nd interview if needed · 4) Offer. Untapped handles onboarding, HR & payroll.'
  },
  calendlyUrl: 'https://calendly.com/try-untapped/hiring-project-kick-off-call',
  stages: CLIENT_STAGES.map(([id, label]) => ({ id, label })),
  candidates: [
    { id: 'kayley', atlasPersonId: '79794307-ec39-4b68-be0b-1a4b856a87fa', name: 'Kayley Van Blerk', headline: 'Principal Research Consultant at HW3 (Hamlyn Williams)', location: 'Cape Town, South Africa', linkedin: 'kayley-van-blerk-5585031b9', rating: 3, niche: ['Engineering', 'Generalist', 'Change Mgmt'], scope: ['180', 'Internal'], cost: 2250, hasCV: false, stage: 'presented', decision: null, exp: [['Principal Research Consultant', 'HW3 (Hamlyn Williams)', '2025–present'], ['IT/SAP Candidate Consultant', 'PRIMA Partners Global', '2024–present'], ['Senior Delivery Consultant', 'Defence Equipment & Support', '2022–2024'], ['Senior Delivery Consultant', 'Gattaca', '2021–2024']], edu: 'BCom Organisational Psychology & Business Mgmt — UCT' },
    { id: 'harold', atlasPersonId: '95f4e9fa-a75a-42c6-8556-c29e841096e6', name: 'Harold Melaphi', headline: 'Talent Partner at Harold M Consulting', location: 'Johannesburg, South Africa', linkedin: 'harold-melaphi-2b303253', rating: 4, niche: ['Tech', 'Generalist', 'GTM'], scope: ['360', '180'], mkt: ['UK', 'EU', 'US', 'EMEA'], cost: 2400, hasCV: false, stage: 'presented', decision: null, exp: [['Talent Partner', 'Harold M Consulting', '2025–present'], ['Senior Account Manager – Recruitment', 'Exposed Solutions', '2023–2024'], ['Senior Talent Partner', 'Global {M}', '2019–2023'], ['Recruitment Consultant (MS Stack)', 'e-Merge IT', '2016–2017']], edu: '—' },
    { id: 'timothy', atlasPersonId: '0d9d35d2-418e-4145-a572-bcbf2231b061', name: 'Timothy Deschamps', headline: 'Principal Research Associate at Proclinical Staffing', location: 'Cape Town, South Africa', linkedin: 'timothy-deschamps-a38460239', rating: 4, niche: ['Tech', 'Change Mgmt'], scope: ['180'], cost: 2100, hasCV: false, stage: 'presented', decision: null, exp: [['Principal Research Associate', 'Proclinical Staffing', '2024–present'], ['IT Functional Consultant', 'PeopleSolved', '2023–2024']], edu: '—' },
    { id: 'nokwanda', atlasPersonId: 'de211e47-3278-4f9d-8458-c0d4c11decd6', name: 'Nokwanda Khanyile', headline: '', location: 'South Africa', linkedin: 'nokwanda-khanyile-81802999', rating: 4, niche: ['Tech'], scope: ['180'], mkt: ['UK', 'US', 'EMEA'], cost: 1950, hasCV: false, stage: 'presented', decision: null, exp: [], edu: '—' },
    { id: 'keesha', atlasPersonId: 'b6e22ec6-0198-4f75-9aef-1d3c11e726e3', name: 'Keesha Paulsen', headline: 'Senior Delivery Consultant (Remote) at Inspire People', location: 'Cape Town, South Africa', linkedin: 'keesha-paulsen', rating: 4, niche: ['Tech'], scope: ['180', 'Exec Search'], cost: 2050, hasCV: false, stage: 'presented', decision: null, exp: [['Senior Delivery Consultant (Remote)', 'Inspire People', '2024–present'], ['Sales & Marketing Receptionist', 'Varsity College', '2023–2024']], edu: 'BSocSci — University of Cape Town' }
  ],
  activity: [], chat: [
    { id: uid(), who: 'Ruan Stander', side: 'Untapped', ts: now(), body: 'Morning Chris — 5 shortlisted for the Delivery Consultant role. Harold & Keesha are my top two.', replies: [] }
  ],
  viewers: {}
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }
  const H = event.headers || {};
  const reqHost = H['x-forwarded-host'] || H['host'] || '';
  const reqBase = reqHost ? `${H['x-forwarded-proto'] || 'https'}://${reqHost}` : (process.env.SITE_URL || 'https://untappeddashboard.netlify.app');
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
    ? { name: 'kpi-workspaces', siteID: process.env.BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }
    : 'kpi-workspaces');

  const key = (id) => 'room:' + id;
  async function load(id) {
    let r = await store.get(key(id), { type: 'json' });
    if (!r && id === SEED.id) r = JSON.parse(JSON.stringify(SEED)); // pilot fallback
    return r;
  }
  const save = (r) => store.setJSON(key(r.id), r);
  const roomLink = (id) => `${reqBase.replace(/\/$/, '')}/room.html?r=${id}`;
  // client-facing view: strip the viewer/engagement log (internal only)
  const pub = (r) => { const { viewers, ...rest } = r; return rest; };

  const { action } = b;
  const isAdmin = () => store.get('__config', { type: 'json' }).then(c => !!(c && c.adminKey && String(b.adminKey || '') === String(c.adminKey)));

  try {
    // ---------- client-facing ----------
    if (action === 'roomGet') {
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      return json(200, { ok: true, room: pub(r) });
    }

    if (action === 'roomIdentify') {
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      const email = String(b.email || '').toLowerCase().trim();
      const name = String(b.name || '').trim();
      if (!email || !name) return json(400, { error: 'name and email required' });
      r.viewers = r.viewers || {};
      const v = r.viewers[email] || { name, email, firstSeen: now(), views: {} };
      v.name = name; v.lastSeen = now();
      r.viewers[email] = v;
      await save(r);
      return json(200, { ok: true, room: pub(r) });
    }

    if (action === 'roomView') { // per-candidate engagement ping
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      const email = String(b.email || '').toLowerCase().trim();
      if (email && r.viewers && r.viewers[email]) {
        const v = r.viewers[email];
        const cid = String(b.candidateId || '');
        v.views = v.views || {};
        v.views[cid] = v.views[cid] || { count: 0, seconds: 0 };
        v.views[cid].count += 1;
        v.views[cid].seconds += Math.max(0, Math.min(3600, Number(b.seconds) || 0));
        v.views[cid].last = now();
        v.lastSeen = now();
        await save(r);
      }
      return json(200, { ok: true });
    }

    if (action === 'roomMove' || action === 'roomAction') {
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      const c = (r.candidates || []).find(x => x.id === String(b.candidateId || ''));
      if (!c) return json(404, { error: 'candidate not found' });
      const who = String(b.viewer || (r.client && r.client.contactName) || 'Client');
      let text;
      if (action === 'roomMove') {
        const st = (r.stages || []).find(s => s.id === String(b.stage || ''));
        if (!st) return json(400, { error: 'bad stage' });
        c.stage = st.id;
        text = `${who} moved ${c.name} → ${st.label}`;
      } else {
        const label = String(b.actionLabel || 'updated');
        c.decision = label;
        if (/interview/i.test(label)) c.stage = /2nd|second/i.test(label) ? 'second' : 'interview';
        if (/offer/i.test(label)) c.stage = 'offer';
        if (/pass|reject|not for us/i.test(label)) c.decision = 'Passed';
        text = `${who}: ${label} — ${c.name}`;
      }
      r.activity = r.activity || [];
      r.activity.unshift({ ts: now(), who, text });
      r.activity = r.activity.slice(0, 200);
      await save(r);
      const body = `<p style="font-size:15px;color:#333">${esc(text)}</p><p style="color:#777;font-size:13px">Room: ${esc(r.role)} · ${esc(r.client.name)}. Update Atlas to match.</p>`;
      await mail([...TEAM], `Room · ${r.client.name} — ${text}`, emailWrap('Client activity', body, roomLink(r.id)));
      await slack(`:busts_in_silhouette: *${r.client.name}* room — ${text}  <${roomLink(r.id)}|open>`);
      return json(200, { ok: true, room: pub(r) });
    }

    if (action === 'roomComment') {
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      const who = String(b.viewer || (r.client && r.client.contactName) || 'Client');
      const bodyText = String(b.body || '').trim();
      if (!bodyText) return json(400, { error: 'empty' });
      r.chat = r.chat || [];
      const msg = { id: uid(), who, side: b.side === 'Untapped' ? 'Untapped' : 'Client', ts: now(), body: bodyText, replies: [] };
      if (b.parentId) {
        const parent = r.chat.find(m => m.id === String(b.parentId));
        if (parent) { parent.replies = parent.replies || []; parent.replies.push(msg); }
        else r.chat.push(msg);
      } else r.chat.push(msg);
      r.activity = r.activity || [];
      r.activity.unshift({ ts: now(), who, text: `${who} commented in discussion` });
      await save(r);
      const eb = `<p style="font-size:15px;color:#333"><b>${esc(who)}</b> commented:</p><p style="color:#333">${esc(bodyText)}</p>`;
      await mail([...TEAM], `Room · ${r.client.name} — new comment`, emailWrap('New comment', eb, roomLink(r.id)));
      await slack(`:speech_balloon: *${r.client.name}* room — ${who}: ${bodyText}  <${roomLink(r.id)}|open>`);
      return json(200, { ok: true, room: pub(r) });
    }

    // ---------- admin / agent (Atlas sync) ----------
    if (action === 'roomUpsert') {
      if (!(await isAdmin())) return json(403, { error: 'admin only' });
      const incoming = b.room;
      if (!incoming || !incoming.id) return json(400, { error: 'room payload required' });
      const existing = await store.get(key(incoming.id), { type: 'json' });
      // preserve client-generated content (activity, chat, viewers, stage/decision) on re-sync
      if (existing) {
        incoming.activity = existing.activity || [];
        incoming.chat = existing.chat || [];
        incoming.viewers = existing.viewers || {};
        const prev = {}; (existing.candidates || []).forEach(c => prev[c.id] = c);
        (incoming.candidates || []).forEach(c => { if (prev[c.id]) { c.stage = prev[c.id].stage || c.stage; c.decision = prev[c.id].decision || c.decision; if (prev[c.id].hasCV) c.hasCV = true; } });
      }
      incoming.syncedAt = now();
      await store.setJSON(key(incoming.id), incoming);
      return json(200, { ok: true, id: incoming.id });
    }

    if (action === 'roomList') {
      if (!(await isAdmin())) return json(403, { error: 'admin only' });
      const out = [];
      const it = await store.list({ prefix: 'room:' });
      for (const blob of (it.blobs || [])) {
        const r = await store.get(blob.key, { type: 'json' });
        if (r) out.push({ id: r.id, role: r.role, client: r.client && r.client.name, candidates: (r.candidates || []).length, syncedAt: r.syncedAt || null, viewers: Object.keys(r.viewers || {}).length });
      }
      return json(200, { ok: true, rooms: out });
    }

    if (action === 'roomAnalytics') {
      if (!(await isAdmin())) return json(403, { error: 'admin only' });
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      const nameById = {}; (r.candidates || []).forEach(c => nameById[c.id] = c.name);
      const viewers = Object.values(r.viewers || {}).map(v => ({
        name: v.name, email: v.email, firstSeen: v.firstSeen, lastSeen: v.lastSeen,
        opened: Object.entries(v.views || {}).map(([cid, s]) => ({ candidate: nameById[cid] || cid, count: s.count, seconds: s.seconds, last: s.last })).sort((a, b2) => b2.seconds - a.seconds)
      })).sort((a, b2) => new Date(b2.lastSeen || 0) - new Date(a.lastSeen || 0));
      return json(200, { ok: true, role: r.role, client: r.client, viewers, activity: (r.activity || []).slice(0, 40) });
    }

    if (action === 'roomUploadCV') {
      if (!(await isAdmin())) return json(403, { error: 'admin only' });
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      const c = (r.candidates || []).find(x => x.id === String(b.candidateId || ''));
      if (!c) return json(404, { error: 'candidate not found' });
      const data = String(b.dataBase64 || '');
      if (!data) return json(400, { error: 'no file' });
      if (data.length > 8 * 1024 * 1024) return json(400, { error: 'file too large' });
      await store.set('cv:' + r.id + ':' + c.id, data); // cv.js serves this (strips data: prefix)
      c.hasCV = true;
      await save(r);
      return json(200, { ok: true });
    }

    if (action === 'roomUploadPhoto') {
      if (!(await isAdmin())) return json(403, { error: 'admin only' });
      const r = await load(String(b.roomId || ''));
      if (!r) return json(404, { error: 'room not found' });
      const c = (r.candidates || []).find(x => x.id === String(b.candidateId || ''));
      if (!c) return json(404, { error: 'candidate not found' });
      const photo = String(b.photo || '');
      if (!/^data:image\//.test(photo)) return json(400, { error: 'photo must be a data: image' });
      if (photo.length > 2.5 * 1024 * 1024) return json(400, { error: 'image too large (max ~2MB)' });
      c.photo = photo;
      await save(r);
      return json(200, { ok: true });
    }

    return json(400, { error: 'unknown action' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
