const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const STATIC_DIR = __dirname;

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

    // ── Proxy endpoint ──
    if (parsed.pathname === '/proxy') {
        const targetUrl = parsed.query.url;
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing ?url= parameter');
        }

        let target;
        try {
            target = new URL(targetUrl);
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Invalid URL');
        }

        const client = target.protocol === 'https:' ? https : http;

        const proxyReq = client.request(target, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
        }, (proxyRes) => {
            // Follow redirects (up to 5)
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                const redirectUrl = new URL(proxyRes.headers.location, target).href;
                // Redirect the client to the proxy with the new URL
                res.writeHead(302, { 'Location': '/proxy?url=' + encodeURIComponent(redirectUrl) });
                return res.end();
            }

            // Build response headers — strip iframe-blocking headers
            const headers = {};
            for (const [key, value] of Object.entries(proxyRes.headers)) {
                const lower = key.toLowerCase();
                if (lower === 'x-frame-options') continue;
                if (lower === 'content-security-policy') continue;
                if (lower === 'content-security-policy-report-only') continue;
                headers[key] = value;
            }

            // Allow our origin to frame the content
            headers['Access-Control-Allow-Origin'] = '*';

            // Rewrite HTML to fix relative URLs
            const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
            if (contentType.includes('text/html')) {
                let body = [];
                proxyRes.on('data', chunk => body.push(chunk));
                proxyRes.on('end', () => {
                    let html = Buffer.concat(body).toString('utf-8');

                    // Inject a <base> tag so relative URLs resolve to the original site
                    const baseTag = '<base href="' + target.origin + target.pathname + '">';
                    if (html.includes('<head>')) {
                        html = html.replace('<head>', '<head>' + baseTag);
                    } else if (html.includes('<HEAD>')) {
                        html = html.replace('<HEAD>', '<HEAD>' + baseTag);
                    } else {
                        html = baseTag + html;
                    }

                    delete headers['content-length'];
                    delete headers['Content-Length'];
                    delete headers['transfer-encoding'];
                    delete headers['Transfer-Encoding'];
                    headers['Content-Type'] = 'text/html; charset=utf-8';

                    res.writeHead(proxyRes.statusCode, headers);
                    res.end(html);
                });
            } else {
                res.writeHead(proxyRes.statusCode, headers);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Proxy error: ' + err.message);
        });

        proxyReq.setTimeout(10000, () => {
            proxyReq.destroy();
            res.writeHead(504, { 'Content-Type': 'text/plain' });
            res.end('Proxy timeout');
        });

        proxyReq.end();
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
