/* Untapped — serves an uploaded candidate CV (PDF) for the presentation viewing window.
 * GET /.netlify/functions/cv?w=<workspaceId>&c=<candidateId>
 * The unguessable workspace + candidate ids act as the access key.
 */
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const w = String(q.w || ''), c = String(q.c || '');
  if (!w || !c) return { statusCode: 400, body: 'missing params' };
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
    ? { name: 'kpi-workspaces', siteID: process.env.BLOBS_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }
    : 'kpi-workspaces');
  let data;
  try { data = await store.get('cv:' + w + ':' + c); } catch (e) { return { statusCode: 500, body: 'error' }; }
  if (!data) return { statusCode: 404, body: 'not found' };
  // stored as base64 (optionally with a data: URI prefix)
  const b64 = data.indexOf(',') >= 0 ? data.slice(data.indexOf(',') + 1) : data;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="cv.pdf"', 'Cache-Control': 'private, max-age=60' },
    body: b64,
    isBase64Encoded: true
  };
};
