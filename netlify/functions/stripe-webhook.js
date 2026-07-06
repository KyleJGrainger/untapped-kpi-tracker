/* Untapped — Stripe webhook (marks a client's retainer as paid).
 * Backup/confirmation to the on-return verifyCheckout call, so payment sticks
 * even if the client closes the tab before redirecting back.
 * Env: STRIPE_WEBHOOK_SECRET (+ RESEND_API_KEY/FROM_EMAIL for the notice, Blobs token on manual deploys)
 * Point Stripe at: https://<your-site>/.netlify/functions/stripe-webhook  (event: checkout.session.completed)
 */
const crypto = require('crypto');
const TEAM = ['kyle@tryuntapped.com', 'Nina@tryuntapped.com', 'pau@tryuntapped.com'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function verify(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(kv => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch (e) { return false; }
}
async function mail(to, subject, html) {
  const { RESEND_API_KEY, FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !FROM_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }) });
  } catch (e) {}
}

exports.handler = async (event) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const raw = event.body || '';
  if (!verify(raw, sig, secret)) return { statusCode: 400, body: 'bad signature' };

  let evt; try { evt = JSON.parse(raw); } catch (e) { return { statusCode: 400, body: 'bad json' }; }
  if (evt.type !== 'checkout.session.completed') return { statusCode: 200, body: 'ignored' };

  const sess = evt.data.object || {};
  const wsId = (sess.metadata && sess.metadata.wsId) || sess.client_reference_id;
  if (!wsId || sess.payment_status !== 'paid') return { statusCode: 200, body: 'nothing to do' };

  const { getStore } = await import('@netlify/blobs');
  const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
    ? { name: 'kpi-workspaces', siteID: process.env.BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }
    : 'kpi-workspaces');
  const ws = await store.get(wsId, { type: 'json' });
  if (!ws) return { statusCode: 200, body: 'workspace gone' };
  if (!ws.onboarding) ws.onboarding = { required: true, retainer: 1000, status: 'pending', signed: null, paid: null, questionnaireDone: false };

  if (!ws.onboarding.paid) {
    ws.onboarding.paid = { amount: (sess.amount_total || 0) / 100, sessionId: sess.id, ts: new Date().toISOString() };
    ws.onboarding.status = ws.onboarding.questionnaireDone ? 'complete' : 'paid';
    await store.setJSON(wsId, ws);
    const amt = ((sess.amount_total || 0) / 100).toFixed(2);
    const html = `<!doctype html><html><body style="margin:0;background:#fbf8fd;font-family:Helvetica,Arial,sans-serif;color:#1a1424">
      <div style="background:#101820;padding:20px 28px"><span style="color:#fff;font-size:20px;font-weight:700">untapped</span></div>
      <div style="height:4px;background:linear-gradient(90deg,#FFC600,#FF6900,#DA291C)"></div>
      <div style="max-width:600px;margin:0 auto;padding:28px">
        <h1 style="font-family:Georgia,serif;font-weight:400;font-size:23px;margin:0 0 14px">Retainer paid</h1>
        <p style="font-size:15px;color:#333"><b>${esc(ws.company || 'A client')}</b> has paid their retainer of <b>£${amt}</b>.</p>
        <p style="color:#999;font-size:12px;margin-top:24px">Untapped · tryuntapped.com</p>
      </div></body></html>`;
    await mail(TEAM, `Retainer paid — ${ws.company || 'client'} · £${amt}`, html);
  }
  return { statusCode: 200, body: 'ok' };
};
