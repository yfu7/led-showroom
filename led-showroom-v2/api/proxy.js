// Vercel serverless proxy: loads external websites for LED-wall content windows by stripping
// frame-blocking headers and injecting a <base> tag. Mirrors server/index.cjs handleProxy().
//
// Every address decision lives in server/urlGuard.cjs — the same CommonJS module server/index.cjs
// requires. package.json is "type": "module", so this file is ESM and loads the .cjs module
// through Node's ESM-imports-CommonJS interop (default import, then destructure).
import https from 'node:https';
import http from 'node:http';
import guard from '../server/urlGuard.cjs';

const {
  MAX_HTML_BYTES,
  REQUEST_TIMEOUT_MS,
  TOO_MANY_REDIRECTS_MESSAGE,
  BODY_TOO_LARGE_MESSAGE,
  resolveSafeTarget,
  upstreamRequestOptions,
  filterResponseHeaders,
  isRedirectStatus,
  readHopCount,
  redirectLocation,
} = guard;

/* vercel.json rewrites /proxy here; redirects bounce through the same path. */
const BASE_PATH = '/api/proxy';

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

export default async function handler(req, res) {
  const query = req.query || {};
  const hops = readHopCount(query.hops);

  // Protocol, credentials, DNS: nothing leaves the process until the address is public unicast.
  const guarded = await resolveSafeTarget(query.url);
  if (!guarded.ok) { sendText(res, guarded.status, guarded.message); return; }
  const { url: target, address, family } = guarded;

  let settled = false;
  const fail = (status, message) => { if (settled) return; settled = true; sendText(res, status, message); };

  const client = target.protocol === 'https:' ? https : http;
  const proxyReq = client.request(target, upstreamRequestOptions(target, address, family), (proxyRes) => {
    if (isRedirectStatus(proxyRes.statusCode) && proxyRes.headers.location) {
      proxyRes.resume();
      let next;
      try { next = new URL(proxyRes.headers.location, target).href; } catch { return fail(502, 'Upstream sent an invalid redirect.'); }
      const location = redirectLocation(BASE_PATH, next, hops);   // null once the hop cap is hit
      if (!location) return fail(400, TOO_MANY_REDIRECTS_MESSAGE);
      if (settled) return;
      settled = true;
      res.writeHead(302, { Location: location, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end();
    }

    const headers = filterResponseHeaders(proxyRes.headers);   // drops CSP/frame, set-cookie, CORS
    const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();

    if (!contentType.includes('text/html')) {
      if (settled) return;
      settled = true;
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.on('error', () => res.destroy());               // pipe() does not forward errors
      proxyRes.pipe(res);                                      // streamed, never buffered
      return;
    }

    const chunks = [];
    let size = 0;
    proxyRes.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_HTML_BYTES) {
        proxyRes.destroy();
        proxyReq.destroy();
        fail(502, BODY_TOO_LARGE_MESSAGE);
        return;
      }
      chunks.push(chunk);
    });
    proxyRes.on('error', () => fail(502, 'Proxy error: upstream response failed'));
    proxyRes.on('end', () => {
      if (settled) return;
      settled = true;
      let html = Buffer.concat(chunks).toString('utf-8');
      const baseTag = '<base href="' + target.origin + target.pathname + '">';
      if (html.includes('<head>')) html = html.replace('<head>', '<head>' + baseTag);
      else if (html.includes('<HEAD>')) html = html.replace('<HEAD>', '<HEAD>' + baseTag);
      else html = baseTag + html;
      // filterResponseHeaders() lower-cases every key, so one delete covers each header.
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers['content-encoding'];
      headers['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(proxyRes.statusCode, headers);
      res.end(html);
    });
  });
  proxyReq.on('error', (err) => fail(502, 'Proxy error: ' + err.message));
  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => { proxyReq.destroy(); fail(504, 'Proxy timeout'); });
  proxyReq.end();
}
