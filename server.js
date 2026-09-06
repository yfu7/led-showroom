const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

const PORT = 3000;
const STATIC_DIR = __dirname;

/* ── Splat pipeline paths (local machine only — not part of the deploy) ── */
const TOOLS_DIR = path.join(STATIC_DIR, '..', 'led-showroom-tools');
const SPACES_DIR = path.join(STATIC_DIR, '..', 'led-showroom-spaces');
const SPLATS_DIR = path.join(STATIC_DIR, '..', 'led-showroom-splats');
const COLMAP_EXE = path.join(TOOLS_DIR, 'bin', 'colmap.exe');
const BRUSH_EXE = path.join(TOOLS_DIR, 'brush_app.exe');
const splatToolsAvailable = () => fs.existsSync(COLMAP_EXE) && fs.existsSync(BRUSH_EXE);

/* Single active pipeline job. Stages: frames → features → match → map → train → done */
let splatJob = null; // { name, stage, pct, log: [], procs: [], ply, error, startedAt }

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
            // Brush prints "Step 1234" style progress — surface as pct
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

    // 1. Frames (4 fps, max 1600px tall — plenty for SfM + training)
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
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
};

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);

    // ── Proxy endpoint — CLOSED ──
    // v1 is deprecated. This endpoint fetched whatever URL the caller named, with no address
    // validation and a wildcard CORS header, which made it an open proxy and an SSRF vector.
    // It is closed rather than repaired; v2 carries the guarded version in
    // led-showroom-v2/server/urlGuard.cjs. See ../README.md.
    if (parsed.pathname === '/proxy') {
        res.writeHead(410, { 'Content-Type': 'text/plain' });
        return res.end('The v1 proxy is closed. Use led-showroom-v2.');
    }

    // ── Splat pipeline endpoints (local only) ──
    if (parsed.pathname === '/api/splat/videos') {
        // List candidate videos from the spaces dir (top level + one deep)
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ available: splatToolsAvailable(), videos: vids }));
    }

    if (parsed.pathname === '/api/splat/start' && req.method === 'POST') {
        let body = [];
        req.on('data', c => body.push(c));
        req.on('end', () => {
            try {
                const { file, steps } = JSON.parse(Buffer.concat(body).toString());
                if (splatJob && splatJob.stage !== 'done' && !splatJob.error) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'A splat job is already running' }));
                }
                if (!splatToolsAvailable()) {
                    res.writeHead(501, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'COLMAP/Brush tools not found on this machine' }));
                }
                const videoPath = path.join(SPACES_DIR, file);
                if (!videoPath.startsWith(SPACES_DIR) || !fs.existsSync(videoPath)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Unknown video: ' + file }));
                }
                const name = 'splat-' + path.basename(file).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '') + '-' + Date.now().toString(36);
                const totalSteps = Math.max(2000, Math.min(60000, parseInt(steps) || 20000));
                splatJob = { name, stage: 'starting', pct: 0, log: [], procs: [], ply: null, error: null, cancelled: false, startedAt: Date.now(), totalSteps };
                runSplatPipeline(videoPath, name, totalSteps)
                    .catch(e => { if (splatJob) { splatJob.error = e.message; splatJob.stage = 'error'; } });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ started: true, name }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (parsed.pathname === '/api/splat/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!splatJob) return res.end(JSON.stringify({ job: null }));
        return res.end(JSON.stringify({
            job: {
                name: splatJob.name, stage: splatJob.stage, pct: splatJob.pct,
                ply: splatJob.ply, error: splatJob.error,
                elapsedSec: Math.round((Date.now() - splatJob.startedAt) / 1000),
                log: splatJob.log.slice(-12),
            }
        }));
    }

    if (parsed.pathname === '/api/splat/cancel' && req.method === 'POST') {
        if (splatJob) {
            splatJob.cancelled = true;
            splatJob.error = 'cancelled';
            splatJob.stage = 'error';
            for (const p of splatJob.procs) { try { p.kill('SIGKILL'); } catch (_) {} }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
    }

    // Serve generated splat files: /splats/output/<name>.ply
    if (parsed.pathname.startsWith('/splats/')) {
        const rel = decodeURIComponent(parsed.pathname.slice('/splats/'.length));
        const full = path.join(SPLATS_DIR, rel);
        if (!full.startsWith(SPLATS_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
        fs.stat(full, (err, st) => {
            if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': st.size,
                'Cache-Control': 'no-cache',
            });
            fs.createReadStream(full).pipe(res);
        });
        return;
    }

    // ── Static file serving ──
    let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    filePath = path.join(STATIC_DIR, decodeURIComponent(filePath));

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not found');
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log('LED Showroom server running at http://localhost:' + PORT);
});
