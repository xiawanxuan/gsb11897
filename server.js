'use strict';
/**
 * Reporting API 演示服务器（零依赖）
 * - 静态托管 public/
 * - 下发 Reporting-Endpoints / Report-To / CSP 响应头
 * - 接收浏览器上报的报告 (POST /api/reports, POST /api/csp-report)
 * - 提供报告拉取 / 清空 / 端点故障模拟 API
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1MB
const MAX_STORED = 2000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let endpointEnabled = true;   // 可通过 /api/admin/endpoint 模拟端点故障
let serverSeq = 0;
const envelopes = [];         // { id, seq, receivedAt, contentType, reports: [...] }

function securityHeaders(req) {
  const origin = `http://${req.headers.host || 'localhost:' + PORT}`;
  return {
    'Reporting-Endpoints': 'default="/api/reports"',
    'Report-To': JSON.stringify({
      group: 'default',
      max_age: 86400,
      endpoints: [{ url: origin + '/api/reports' }],
    }),
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      'report-to default',
      'report-uri /api/csp-report',
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
  };
}

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function storeReports(contentType, parsed) {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const reports = list.map((r) => {
    // 兼容 legacy report-uri 的 csp-report 包装
    if (r && r['csp-report']) {
      return { type: 'csp-violation', url: r['csp-report']['document-uri'] || '', body: r['csp-report'] };
    }
    return r;
  });
  const envelope = {
    id: `srv-${++serverSeq}`,
    seq: serverSeq,
    receivedAt: Date.now(),
    contentType,
    reports,
  };
  envelopes.push(envelope);
  if (envelopes.length > MAX_STORED) envelopes.splice(0, envelopes.length - MAX_STORED);
  return envelope;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    if (!endpointEnabled) {
      return send(res, 503, { ok: false, error: 'report endpoint disabled (simulated outage)' });
    }
    return send(res, 200, {
      ok: true,
      registered: true,
      groups: ['default'],
      endpoint: '/api/reports',
      serverTime: Date.now(),
    });
  }

  if (url.pathname === '/api/reports' && req.method === 'POST') {
    if (!endpointEnabled) return send(res, 503, { ok: false, error: 'endpoint disabled' });
    try {
      const raw = await readBody(req);
      const parsed = raw ? JSON.parse(raw) : [];
      const env = storeReports(req.headers['content-type'] || '', parsed);
      return send(res, 200, { ok: true, stored: env.reports.length });
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/csp-report' && req.method === 'POST') {
    if (!endpointEnabled) return send(res, 503, { ok: false, error: 'endpoint disabled' });
    try {
      const raw = await readBody(req);
      const parsed = raw ? JSON.parse(raw) : {};
      const env = storeReports(req.headers['content-type'] || 'application/csp-report', parsed);
      return send(res, 200, { ok: true, stored: env.reports.length });
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/reports' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const list = envelopes.filter((e) => e.receivedAt > since);
    return send(res, 200, { enabled: endpointEnabled, serverTime: Date.now(), envelopes: list });
  }

  if (url.pathname === '/api/reports' && req.method === 'DELETE') {
    envelopes.length = 0;
    return send(res, 200, { ok: true, cleared: true });
  }

  if (url.pathname === '/api/admin/endpoint' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      endpointEnabled = Boolean(body.enabled);
      return send(res, 200, { ok: true, endpointEnabled });
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err.message || err) });
    }
  }

  return send(res, 404, { ok: false, error: 'not found' });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...securityHeaders(req),
    });
  });
}

function appHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => send(res, 500, { ok: false, error: String(err) }));
    return;
  }
  serveStatic(req, res, url);
}

const server = http.createServer(appHandler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Reporting API demo: http://localhost:${PORT} (bound ${HOST})`);
  });
}

module.exports = { server, handleApi, appHandler };
