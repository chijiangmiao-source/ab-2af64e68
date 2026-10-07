'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crdt = require('./crdt');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

/** 演练存储（内存） */
const drills = new Map();
let nextDrillId = 1;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) reject(new Error('请求体过大'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // 健康响应
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok', drills: drills.size });
    }

    // 创建演练：POST /api/drills { replicas?: [n1,n2,n3] }
    if (req.method === 'POST' && url.pathname === '/api/drills') {
      const body = await readBody(req);
      const names = body.replicas || ['alpha', 'beta', 'gamma'];
      let drill;
      try {
        drill = crdt.createDrill(names);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
      const id = String(nextDrillId++);
      drills.set(id, drill);
      return sendJson(res, 201, { ok: true, id, replicas: drill.replicas });
    }

    // 查询演练：GET /api/drills/:id
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'drills' && parts.length === 3) {
      const drill = drills.get(parts[2]);
      if (!drill) return sendJson(res, 404, { ok: false, error: `演练不存在: ${parts[2]}` });
      return sendJson(res, 200, { ok: true, id: parts[2], ...crdt.snapshot(drill) });
    }

    // 录入事件：POST /api/drills/:id/events { type, ... }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'drills' && parts[3] === 'events') {
      const drill = drills.get(parts[2]);
      if (!drill) return sendJson(res, 404, { ok: false, error: `演练不存在: ${parts[2]}` });
      const body = await readBody(req);
      const result = crdt.applyEvent(drill, body);
      const status = result.ok ? 200 : 400;
      return sendJson(res, status, { ...result, state: crdt.snapshot(drill) });
    }

    // 页面
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(INDEX_HTML).pipe(res);
    }

    return sendJson(res, 404, { ok: false, error: 'Not Found' });
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`deepspace-offline-list listening on http://${HOST}:${PORT}`);
  });
}

module.exports = server;
