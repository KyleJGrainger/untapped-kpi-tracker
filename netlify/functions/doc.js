/* Untapped — signed document (execution copy) PDF generator.
 * Produces a legally-oriented PDF of a signed MSA or Work Order:
 *   • the full lawyer-approved agreement text (MSA fetched live from the site;
 *     WO composed from the stored, agreed fields),
 *   • an execution page naming both parties with e-signature audit data
 *     (signatory, company reg/address, IP, UK timestamps),
 *   • a SHA-256 integrity hash of the exact agreed text (tamper-evidence).
 *
 * Two modes:
 *   POST {kind:'msa'|'wo', wsId, candidateId?, roomId?, download?, adminKey?, pin?}
 *     → download:true  → raw application/pdf (Content-Disposition attachment)
 *     → otherwise      → { ok, pdfBase64, filename, hash }  (used by email senders)
 * Access: the unguessable wsId / roomId is the capability (same model as the funnel);
 *   admin actions additionally accept adminKey.
 */
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const json = (s, o) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const sha256 = t => 'sha256:' + crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const fmt = ts => { try { return new Date(ts).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' }) + ' (UK)'; } catch (e) { return String(ts || '—'); } };
const money = n => '£' + (Number(n) || 0).toLocaleString('en-GB');

function htmlToText(html) {
  let h = String(html || '');
  h = h.replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/<\/(p|div|h[1-6]|li|tr|table|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<[^>]+>/g, '');
  h = h.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
       .replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&nbsp;|&#160;/g, ' ')
       .replace(/&#x2019;/g, "'").replace(/[​‎‏]/g, '');
  h = h.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  return h.trim();
}

// pdf-lib's WinAnsi fonts can't encode smart punctuation / NBSP etc — fold to ASCII.
function ascii(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
    .replace(/·/g, '-').replace(/[^\x09\x0a\x20-\x7e£€]/g, '');
}

async function fetchMsaText(base, region) {
  const file = region === 'Philippines' ? 'msa-philippines.html' : 'msa-south-africa.html';
  const r = await fetch(base.replace(/\/$/, '') + '/' + file);
  if (!r.ok) throw new Error('could not load agreement (' + r.status + ')');
  return { file, text: htmlToText(await r.text()) };
}

function woText(c, wo, region) {
  const L = [];
  L.push('WORK ORDER');
  L.push('This Work Order is issued under and forms part of the Master Services Agreement between the parties.');
  L.push('');
  L.push('Employee / Associate: ' + (wo.employeeName || c.name || '—'));
  L.push('Role / Job title: ' + (wo.jobTitle || c.headline || '—'));
  L.push('Region: ' + (region || '—'));
  L.push('Start date: ' + (wo.startDate || '—'));
  L.push('Gross monthly salary: ' + money(wo.grossSalaryMonthly));
  L.push('Notice period: ' + (wo.noticePeriod || '1 calendar month'));
  L.push('Annual leave: ' + (wo.annualLeaveDays != null ? wo.annualLeaveDays + ' days' : '—'));
  L.push('Sick leave: ' + (wo.sickLeaveDays != null ? wo.sickLeaveDays + ' days' : '—'));
  if (wo.commissionDetails) L.push('Commission / bonus: ' + wo.commissionDetails);
  if (wo.tmcNote) L.push('Total monthly cost note: ' + wo.tmcNote);
  if (wo.jobDescription) { L.push(''); L.push('Job description:'); L.push(wo.jobDescription); }
  return L.join('\n');
}

async function buildPdf({ title, subtitle, parties, bodyText, bodyHeading, hash }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [PW, PH] = [595.28, 841.89];
  const M = 50, W = PW - M * 2;
  let page, y;
  const header = () => {
    page.drawRectangle({ x: 0, y: PH - 34, width: PW, height: 34, color: rgb(0.063, 0.094, 0.125) });
    page.drawText('untapped', { x: M, y: PH - 23, size: 14, font: bold, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 0, y: PH - 37, width: PW, height: 3, color: rgb(1, 0.776, 0) });
  };
  const nl = () => { page = pdf.addPage([PW, PH]); header(); y = PH - 60; };
  nl();
  const draw = (txt, f, size, color, gap) => {
    txt = ascii(txt);
    (txt.split('\n')).forEach(para => {
      if (para === '') { y -= size * 0.7; return; }
      const words = para.split(' '); let line = '';
      const flush = () => { if (y < M + size) nl(); if (line) page.drawText(line, { x: M, y: y - size, size, font: f, color: color || rgb(0.12, 0.12, 0.16) }); y -= size * 1.4; line = ''; };
      words.forEach(w => { const t = line ? line + ' ' + w : w; if (f.widthOfTextAtSize(t, size) > W && line) { flush(); line = w; } else line = t; });
      flush();
    });
    if (gap) y -= gap;
  };
  // Execution page
  draw(title, bold, 20, rgb(0.06, 0.09, 0.12), 2);
  if (subtitle) draw(subtitle, font, 11, rgb(0.4, 0.4, 0.45), 8);
  draw('EXECUTION', bold, 12, rgb(0.85, 0.16, 0.11), 4);
  parties.forEach(p => {
    if (y < M + 60) nl();
    page.drawText(ascii(p.role), { x: M, y: y - 11, size: 10, font: bold, color: rgb(0.4, 0.4, 0.45) }); y -= 16;
    p.lines.forEach(ln => { draw(ln, font, 11); });
    y -= 8;
  });
  y -= 4; if (y < M + 30) nl();
  draw('Document integrity — SHA-256 hash of the exact agreed text:', bold, 9, rgb(0.4, 0.4, 0.45), 0);
  draw(hash, font, 8, rgb(0.45, 0.45, 0.5), 6);
  draw('This is an electronically executed copy. The signatures above were captured electronically with the audit data shown, under the Electronic Communications Act 2000.', font, 8.5, rgb(0.5, 0.5, 0.55), 0);
  // Agreement body on a fresh page
  if (bodyText) { nl(); draw(bodyHeading || 'AGREEMENT', bold, 13, rgb(0.06, 0.09, 0.12), 6); draw(bodyText, font, 9, rgb(0.15, 0.15, 0.2), 0); }
  return await pdf.save();
}

async function makeSignedDoc({ kind, ws, candidate, base }) {
  const o = ws.onboarding || {};
  const clientCo = (o.signed && o.signed.company) || {};
  if (kind === 'msa') {
    const sig = o.signed || {};
    const { file, text } = await fetchMsaText(base, o.region);
    const hash = sha256(o.region + '|' + text);
    const parties = [
      { role: 'THE SERVICE PROVIDER', lines: ['Untapped (a trading division of Create and Adapt Limited)', 'Company registration number: 9723247', o.msaCountersign ? ('Signed by: ' + o.msaCountersign.name + (o.msaCountersign.title ? ', ' + o.msaCountersign.title : '')) : 'Awaiting counter-signature', o.msaCountersign ? ('Date: ' + fmt(o.msaCountersign.ts)) : ''].filter(Boolean) },
      { role: 'THE CLIENT', lines: ['Company: ' + (clientCo.name || ws.company || '—'), clientCo.regNumber ? ('Company registration number: ' + clientCo.regNumber) : '', clientCo.address ? ('Registered address: ' + clientCo.address) : '', 'Signed by: ' + (sig.name || '—'), 'Date: ' + fmt(sig.ts), 'IP address at signing: ' + (sig.ip || 'n/a')].filter(Boolean) }
    ];
    const bytes = await buildPdf({ title: 'Master Services Agreement', subtitle: (o.region || '') + ' · executed copy · ' + file, parties, bodyText: text, bodyHeading: 'MASTER SERVICES AGREEMENT', hash });
    return { bytes, filename: 'MSA-' + (ws.company || 'client').replace(/[^a-z0-9]+/gi, '-') + '.pdf', hash };
  }
  // work order
  const c = candidate || {};
  const wo = c.workOrder || o.workOrder || {};
  const body = woText(c, wo, o.region || ws.region);
  const hash = sha256('WO|' + body);
  const cs = wo.signed || {}, us = wo.untappedSigned || {};
  const parties = [
    { role: 'THE SERVICE PROVIDER', lines: ['Untapped (a trading division of Create and Adapt Limited)', 'Company registration number: 9723247', us.name ? ('Signed by: ' + us.name + (us.title ? ', ' + us.title : '')) : 'Awaiting counter-signature', us.ts ? ('Date: ' + fmt(us.ts)) : ''].filter(Boolean) },
    { role: 'THE CLIENT', lines: ['Company: ' + (ws.company || (ws.client && ws.client.name) || '—'), 'Signed by: ' + (cs.name || '—'), 'Date: ' + fmt(cs.ts)].filter(Boolean) }
  ];
  const bytes = await buildPdf({ title: 'Work Order', subtitle: (c.name || wo.employeeName || '') + ' · executed copy', parties, bodyText: body, bodyHeading: 'WORK ORDER', hash });
  return { bytes, filename: 'WorkOrder-' + ((c.name || 'candidate').replace(/[^a-z0-9]+/gi, '-')) + '.pdf', hash };
}

exports.makeSignedDoc = makeSignedDoc;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }
  const H = event.headers || {};
  const base = (H['x-forwarded-host'] || H['host']) ? `${H['x-forwarded-proto'] || 'https'}://${H['x-forwarded-host'] || H['host']}` : (process.env.SITE_URL || 'https://hire.tryuntapped.com');
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
    ? { name: 'kpi-workspaces', siteID: process.env.BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }
    : 'kpi-workspaces');
  try {
    const kind = b.kind === 'wo' ? 'wo' : 'msa';
    let ws, candidate = null;
    if (b.roomId) {
      const room = await store.get('room:' + b.roomId, { type: 'json' });
      if (!room) return json(404, { error: 'room not found' });
      ws = { company: room.client && room.client.name, region: room.region, onboarding: {} };
      candidate = (room.candidates || []).find(x => x.id === String(b.candidateId || ''));
      if (!candidate) return json(404, { error: 'candidate not found' });
    } else {
      ws = await store.get(String(b.wsId || ''), { type: 'json' });
      if (!ws) return json(404, { error: 'not found' });
      if (kind === 'wo') candidate = ((ws.onboarding && ws.onboarding.shortlist) || []).find(x => x.id === String(b.candidateId || '')) || { name: (ws.onboarding && ws.onboarding.hired && ws.onboarding.hired.name), workOrder: ws.onboarding && ws.onboarding.workOrder };
    }
    const { bytes, filename, hash } = await makeSignedDoc({ kind, ws, candidate, base });
    if (b.download) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="' + filename + '"' }, body: Buffer.from(bytes).toString('base64'), isBase64Encoded: true };
    }
    return json(200, { ok: true, pdfBase64: Buffer.from(bytes).toString('base64'), filename, hash });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
