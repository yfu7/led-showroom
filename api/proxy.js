const https = require('https');
const http = require('http');

module.exports = (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        res.status(400).send('Missing ?url= parameter');
        return;
    }

    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        res.status(400).send('Invalid URL');
        return;
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
        if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            const redirectUrl = new URL(proxyRes.headers.location, target).href;
            res.writeHead(302, { 'Location': '/api/proxy?url=' + encodeURIComponent(redirectUrl) });
            return res.end();
        }

        const headers = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            const lower = key.toLowerCase();
            if (lower === 'x-frame-options') continue;
            if (lower === 'content-security-policy') continue;
            if (lower === 'content-security-policy-report-only') continue;
            headers[key] = value;
        }
        headers['Access-Control-Allow-Origin'] = '*';

        const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('text/html')) {
            const body = [];
            proxyRes.on('data', chunk => body.push(chunk));
            proxyRes.on('end', () => {
                let html = Buffer.concat(body).toString('utf-8');
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
        res.status(502).send('Proxy error: ' + err.message);
    });

    proxyReq.setTimeout(10000, () => {
        proxyReq.destroy();
        res.status(504).send('Proxy timeout');
    });

    proxyReq.end();
};
