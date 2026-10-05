#!/usr/bin/env node
/**
 * 一次性诊断：自己 spawn 宿主（保持 stdin 打开），再做**裸 HTTP 升级**。
 * 不参与构建，只在排查握手问题时使用。
 * 用法：node tools/bench/_debug-handshake.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIB_DIR = path.join(CLIENT_ROOT, 'bridge', 'host-desktop', 'build', 'install', 'wise-bridge', 'lib');

const child = spawn('java', ['-cp', path.join(LIB_DIR, '*'), 'com.huicang.wise.bridge.host.desktop.MainKt',
  '--backend', 'http://127.0.0.1:18080', '--ver', 'debug'], { stdio: ['pipe', 'pipe', 'pipe'] });

child.stderr.on('data', (d) => process.stderr.write(`[host stderr] ${d}`));
child.on('exit', (code, sig) => console.log(`[host exited] code=${code} signal=${sig}`));

const handshake = await new Promise((resolve, reject) => {
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const line = buf.split('\n').find((l) => l.trim().startsWith('{'));
    if (line) {
      resolve(JSON.parse(line));
    }
  });
  setTimeout(() => reject(new Error('handshake timeout')), 8000);
});
console.log('handshake:', JSON.stringify(handshake));

await new Promise((r) => setTimeout(r, 300));
console.log('child alive?', child.exitCode === null);

const key = crypto.randomBytes(16).toString('base64');
// v5：升级 URL 上**没有任何凭据**，但必须带客户端临时公钥（k），否则服务端按
// "缺少客户端公钥"回 400。这里只生成一对临时密钥，不做 ECDH —— 本探针只看升级这一段。
const clientKey = crypto.createECDH('prime256v1').generateKeys().toString('hex');
const req = http.request({
  host: '127.0.0.1',
  port: handshake.port,
  path: `/bridge?k=${clientKey}`,
  method: 'GET',
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
  },
});

req.on('upgrade', (res, socket) => {
  console.log('UPGRADE 101 status:', res.statusCode, JSON.stringify(res.headers));
  socket.destroy();
  finish();
});
req.on('response', (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => {
    console.log('HTTP status:', res.statusCode, JSON.stringify(res.headers));
    console.log('body:', body);
    finish();
  });
});
req.on('error', (e) => {
  console.log('ERROR:', e.message);
  finish();
});
req.end();

setTimeout(() => {
  console.log('(4s 无响应)');
  finish();
}, 4000);

function finish() {
  child.stdin.write('shutdown\n');
  setTimeout(() => {
    child.kill();
    process.exit(0);
  }, 500);
}
