/*
 * LED Showroom v2 — local server.
 *
 * Responsibilities:
 *   1. /proxy?url=…        — iframe-unblocking website proxy (strips X-Frame-Options / CSP, injects <base>).
 *   2. /api/splat/*        — local Gaussian-splat generation pipeline (ffmpeg → COLMAP → Brush). Only
 *                            available when the tools exist next to the repo (see TOOLS_DIR).
 *   3. /splats/*           — serves generated .ply files.
 *   4. Static /dist        — production build (when present). In development Vite serves the app and
 *                            proxies the routes above to this server (see vite.config.ts).
 *
 * Usage:  PORT=3001 node server/index.js
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const urlGuard = require('./urlGuard.cjs');   // shared with api/proxy.js (see that file's header)

const PORT = Number(process.env.PORT || 3001);
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

/* ── Splat pipeline paths (local machine only — not part of the deploy) ── */
const candidatesFor = (name) => [
  path.join(ROOT, '..', name),                 // <repo>/led-showroom-tools when v2 lives inside the v1 repo
  path.join(ROOT, '..', '..', name),
  path.join(ROOT, '..', '..', '..', '..', name), // worktree layout: repo/.claude/worktrees/<wt>/led-showroom-v2
  path.join(ROOT, '..', '..', '..', '..', '..', name),
  path.join('F:', 'Projects', 'Code', name),   // the original machine layout
];
const firstExisting = (name) => candidatesFor(name).find(p => fs.existsSync(p)) || candidatesFor(name)[0];
const TOOLS_DIR = process.env.SPLAT_TOOLS_DIR || firstExisting('led-showroom-tools');
const SPACES_DIR = process.env.SPLAT_SPACES_DIR || firstExisting('led-showroom-spaces');
const SPLATS_DIR = process.env.SPLAT_OUT_DIR || firstExisting('led-showroom-splats');
const COLMAP_EXE = path.join(TOOLS_DIR, 'bin', 'colmap.exe');
const BRUSH_EXE = path.join(TOOLS_DIR, 'brush_app.exe');
const splatToolsAvailable = () => fs.existsSync(COLMAP_EXE) && fs.existsSync(BRUSH_EXE);

/* Single active pipeline job. Stages: frames → features → match → map → train → done */
let splatJob = null;

function jobLog(line) {
  if (!splatJob) return;
  const t = String(line).trim();
  if (!t) return;
  splatJob.log.push(t);
  if (splatJob.log.length > 200) splatJob.log.splice(0, splatJob.log.length - 200);
}

function runStep(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, windowsHide: true });
    if (splatJob) splatJob.procs.push(p);
    p.stdout.on('data', d => {
      const s = d.toString();
      s.split('\n').forEach(jobLog);
      if (splatJob && splatJob.stage === 'train') {
        const m = s.match(/[Ss]tep[:\s]+(\d+)/);
        if (m) splatJob.pct = Math.min(99, Math.round((+m[1] / splatJob.totalSteps) * 100));
      }
    });
    p.stderr.on('data', d => d.toString().split('\n').forEach(jobLog));
    p.on('error', reject);
    p.on('close', code => {
      if (splatJob && splatJob.cancelled) return reject(new Error('cancelled'));
      code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code));
    });
  });
}

async function runSplatPipeline(videoPath, name, totalSteps) {
  const work = path.join(SPLATS_DIR, name);
  const images = path.join(work, 'images');
  const sparse = path.join(work, 'sparse');
  const outDir = path.join(SPLATS_DIR, 'output');
  fs.mkdirSync(images, { recursive: true });
  fs.mkdirSync(sparse, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  splatJob.totalSteps = totalSteps;

  // 1. Frames (4 fps, max 1600px on the long edge — plenty for SfM + training)
  splatJob.stage = 'frames'; splatJob.pct = 0;
  await runStep('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath,
    '-vf', 'fps=4,scale=if(gt(iw\\,ih)\\,-2\\,min(1600\\,iw)):if(gt(iw\\,ih)\\,min(1600\\,ih)\\,-2)',
    '-qscale:v', '2', path.join(images, 'frame_%04d.jpg')]);

  // 2-4. COLMAP: features → sequential match → map
  splatJob.stage = 'features'; splatJob.pct = 15;
  const db = path.join(work, 'database.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  await runStep(COLMAP_EXE, ['feature_extractor', '--database_path', db,
    '--image_path', images, '--ImageReader.camera_model', 'SIMPLE_RADIAL',
    '--ImageReader.single_camera', '1']);

  splatJob.stage = 'match'; splatJob.pct = 35;
  await runStep(COLMAP_EXE, ['sequential_matcher', '--database_path', db,
    '--SequentialMatching.overlap', '15', '--SequentialMatching.loop_detection', '0']);

  splatJob.stage = 'map'; splatJob.pct = 50;
  await runStep(COLMAP_EXE, ['mapper', '--database_path', db,
    '--image_path', images, '--output_path', sparse]);
  if (!fs.existsSync(path.join(sparse, '0'))) {
    throw new Error('COLMAP could not reconstruct camera poses from this video (not enough overlap/features). Try a slower walkthrough with more overlap.');
  }

  // 5. Brush training → .ply
  splatJob.stage = 'train'; splatJob.pct = 60;
  const plyName = name + '.ply';
  await runStep(BRUSH_EXE, [work,
    '--total-steps', String(totalSteps),
    '--export-every', String(totalSteps),
    '--export-path', outDir,
    '--export-name', plyName,
    '--max-resolution', '1600']);
  const plyPath = path.join(outDir, plyName);
  if (!fs.existsSync(plyPath)) throw new Error('Training finished but no .ply exported');

  splatJob.stage = 'done'; splatJob.pct = 100;
  splatJob.ply = '/splats/output/' + plyName;
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
  '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ply': 'application/octet-stream',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* Redirects bounce back through /proxy, so the guard re-runs on every hop. */
const PROXY_BASE_PATH = '/proxy';

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

async function runProxy(req, res, parsed) {
  const hops = urlGuard.readHopCount(parsed.query.hops);

  // Protocol, credentials, DNS: nothing leaves the process until the address is public unicast.
  const guarded = await urlGuard.resolveSafeTarget(parsed.query.url);
  if (!guarded.ok) return sendText(res, guarded.status, guarded.message);
  const { url: target, address, family } = guarded;

  let settled = false;
  const fail = (status, message) => { if (settled) return; settled = true; sendText(res, status, message); };

  const client = target.protocol === 'https:' ? https : http;
  const proxyReq = client.request(target, urlGuard.upstreamRequestOptions(target, address, family), (proxyRes) => {
    if (urlGuard.isRedirectStatus(proxyRes.statusCode) && proxyRes.headers.location) {
      proxyRes.resume();
      let next;
      try { next = new URL(proxyRes.headers.location, target).href; } catch { return fail(502, 'Upstream sent an invalid redirect.'); }
      const location = urlGuard.redirectLocation(PROXY_BASE_PATH, next, hops);   // null once the hop cap is hit
      if (!location) return fail(400, urlGuard.TOO_MANY_REDIRECTS_MESSAGE);
      if (settled) return;
      settled = true;
      res.writeHead(302, { 'Location': location, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end();
    }

    const headers = urlGuard.filterResponseHeaders(proxyRes.headers);   // drops CSP/frame, set-cookie, CORS
    const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();

    if (!contentType.includes('text/html')) {
      if (settled) return;
      settled = true;
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.on('error', () => res.destroy());                       // pipe() does not forward errors
      proxyRes.pipe(res);                                              // streamed, never buffered
      return;
    }

    const chunks = [];
    let size = 0;
    proxyRes.on('data', (chunk) => {
      size += chunk.length;
      if (size > urlGuard.MAX_HTML_BYTES) {
        proxyRes.destroy();
        proxyReq.destroy();
        fail(502, urlGuard.BODY_TOO_LARGE_MESSAGE);
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
  proxyReq.setTimeout(urlGuard.REQUEST_TIMEOUT_MS, () => { proxyReq.destroy(); fail(504, 'Proxy timeout'); });
  proxyReq.end();
}

function handleProxy(req, res, parsed) {
  runProxy(req, res, parsed).catch((err) => {
    if (res.headersSent) { res.end(); return; }
    sendText(res, 502, 'Proxy error: ' + err.message);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname || '/';

  if (p === '/proxy') return handleProxy(req, res, parsed);

  if (p === '/api/health') return json(res, 200, { ok: true, splatTools: splatToolsAvailable(), toolsDir: TOOLS_DIR, spacesDir: SPACES_DIR });

  if (p === '/api/splat/videos') {
    const vids = [];
    try {
      const scan = (dir, rel) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (f.isDirectory() && !rel) scan(path.join(dir, f.name), f.name);
          else if (/\.(mp4|webm|mov)$/i.test(f.name)) {
            const full = path.join(dir, f.name);
            const st = fs.statSync(full);
            vids.push({ rel: (rel ? rel + '/' : '') + f.name, sizeMB: Math.round(st.size / 1e6) });
          }
        }
      };
      if (fs.existsSync(SPACES_DIR)) scan(SPACES_DIR, '');
    } catch (e) { /* dir missing = empty list */ }
    return json(res, 200, { available: splatToolsAvailable(), videos: vids });
  }

  if (p === '/api/splat/start' && req.method === 'POST') {
    const body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const { file, steps } = JSON.parse(Buffer.concat(body).toString());
        if (splatJob && splatJob.stage !== 'done' && !splatJob.error) return json(res, 409, { error: 'A splat job is already running' });
        if (!splatToolsAvailable()) return json(res, 501, { error: 'COLMAP/Brush tools not found on this machine' });
        const videoPath = path.join(SPACES_DIR, file);
        if (!videoPath.startsWith(SPACES_DIR) || !fs.existsSync(videoPath)) return json(res, 400, { error: 'Unknown video: ' + file });
        const name = 'splat-' + path.basename(file).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') + '-' + Date.now().toString(36);
        const totalSteps = Math.max(2000, Math.min(60000, parseInt(steps) || 20000));
        splatJob = { name, stage: 'starting', pct: 0, log: [], procs: [], ply: null, error: null, cancelled: false, startedAt: Date.now(), totalSteps };
        runSplatPipeline(videoPath, name, totalSteps).catch(e => { if (splatJob) { splatJob.error = e.message; splatJob.stage = 'error'; } });
        json(res, 200, { started: true, name });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (p === '/api/splat/status') {
    if (!splatJob) return json(res, 200, { job: null });
    return json(res, 200, { job: {
      name: splatJob.name, stage: splatJob.stage, pct: splatJob.pct, ply: splatJob.ply, error: splatJob.error,
      elapsedSec: Math.round((Date.now() - splatJob.startedAt) / 1000), log: splatJob.log.slice(-12),
    } });
  }

  if (p === '/api/splat/cancel' && req.method === 'POST') {
    if (splatJob) {
      splatJob.cancelled = true; splatJob.error = 'cancelled'; splatJob.stage = 'error';
      for (const pr of splatJob.procs) { try { pr.kill('SIGKILL'); } catch (_) { /* already gone */ } }
    }
    return json(res, 200, { ok: true });
  }

  if (p.startsWith('/splats/')) {
    const rel = decodeURIComponent(p.slice('/splats/'.length));
    const full = path.join(SPLATS_DIR, rel);
    if (!full.startsWith(SPLATS_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      fs.createReadStream(full).pipe(res);
    });
    return;
  }

  /* ── Static (production build) ── */
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('No production build. Run `npm run dev` for development (Vite serves the app and proxies to this server), or `npm run build` first.');
  }
  let filePath = path.join(DIST_DIR, decodeURIComponent(p === '/' ? '/index.html' : p));
  if (!filePath.startsWith(DIST_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) filePath = path.join(DIST_DIR, 'index.html'); // SPA fallback
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log('LED Showroom v2 server on http://localhost:' + PORT + (fs.existsSync(DIST_DIR) ? ' (serving dist/)' : ' (API only — run `npm run dev` for the app)'));
  console.log('Splat tools: ' + (splatToolsAvailable() ? 'available' : 'not found') + ' (' + TOOLS_DIR + ')');
});
