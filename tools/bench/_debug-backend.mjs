#!/usr/bin/env node
/** 一次性诊断：真后端对 GET 请求到底要不要信封体。用法：node tools/bench/_debug-backend.mjs <baseUrl> */
const base = process.argv[2] ?? 'http://127.0.0.1:18080';

function envelope(packetType, data = {}) {
  return JSON.stringify({
    header: { request_id: `probe-${Date.now()}`, packet_type: packetType, timestamp: Date.now() },
    payload: { code: 'RES-0000', message: '请求', data },
  });
}

const cases = [
  { name: 'GET 无 body 无 auth', url: `${base}/api/dashboard/summary`, method: 'GET' },
  { name: 'GET + 信封 body 无 auth', url: `${base}/api/dashboard/summary`, method: 'GET', body: envelope('DASHBOARD_SUMMARY') },
  { name: 'GET + 信封 body + 伪 bearer', url: `${base}/api/dashboard/summary`, method: 'GET', body: envelope('DASHBOARD_SUMMARY'), auth: 'Bearer fake-token' },
  { name: 'POST human.challenge（公开端点，对照组）', url: `${base}/api/human/challenge`, method: 'POST', body: envelope('UNKNOWN', { purpose: 'LOGIN', platform: 'desktop', clientVersion: '1.0.0-debug' }) },
];

for (const c of cases) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (c.body) {
    headers['Content-Length'] = Buffer.byteLength(c.body);
  }
  if (c.auth) {
    headers.Authorization = c.auth;
  }
  try {
    const res = await fetch(c.url, { method: c.method, headers, body: c.body });
    const text = await res.text();
    console.log(`${c.name}\n  → HTTP ${res.status}  ${text.slice(0, 220)}`);
  } catch (e) {
    console.log(`${c.name}\n  → ERROR ${e.message}`);
  }
}
