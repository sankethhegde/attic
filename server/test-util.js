// Helpers for the server tests that play several machines (transfers.test.js). Not a test file itself.
// 127.0.0.1 is the HP; 127.0.0.2 and up stand in for other machines on the network.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { encode, createParser, OP } = require('./ws');

function startServer(env) {
  const s = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { ATTIC_DISCOVERY_PORT: '0' }, env), stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  return new Promise((resolve, reject) => {
    s.stdout.on('data', d => { out += d; if (out.includes('Shares:')) resolve(s); });
    s.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
const stopServer = s => new Promise(r => { s.removeAllListeners('exit'); if (s.exitCode !== null) return r(); s.on('exit', r); s.kill(); });

// One machine: a source address with its own cookie jar.
function client(port, from) {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  function keep(res) {
    for (const sc of res.headers['set-cookie'] || []) {
      const [pair] = sc.split(';'), i = pair.indexOf('=');
      if (/Max-Age=0/.test(sc)) delete jar[pair.slice(0, i)]; else jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
  }
  function request(method, url, headers = {}) {
    const h = Object.assign({}, headers);
    if (cookieHeader() && !h.Cookie) h.Cookie = cookieHeader();
    return http.request({ host: '127.0.0.1', port, localAddress: from, method, path: url, headers: h });
  }
  const c = {
    jar, cookieHeader,
    async call(method, url, body, headers = {}) {
      if (body === undefined && method !== 'GET' && method !== 'HEAD') body = {};
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const h = Object.assign({}, headers);
      if (data) Object.assign(h, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      const res = await new Promise((resolve, reject) => { const r = request(method, url, h); r.on('response', resolve); r.on('error', reject); r.end(data); });
      keep(res);
      let text = '';
      for await (const chunk of res) text += chunk;
      let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
      return { status: res.statusCode, json, headers: res.headers };
    },
    // Streams `size` bytes made by `gen(offset, n)` as the body; resolves with the response and the
    // SHA-256 of what was sent. `abortAfter` cuts the connection after that many bytes; `chunkDelay`
    // waits that many ms between 1 MiB chunks; `pauseAt` holds the rest until `gate` resolves.
    upload(url, size, { gen = patternBytes, declared = size, abortAfter = null, chunkDelay = 0, pauseAt = null, gate = null } = {}) {
      return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const r = request('PUT', url, { 'X-Attic-Upload': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': declared });
        r.on('response', async res => { let t = ''; for await (const ch of res) t += ch; resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null, sha: hash.digest('hex') }); });
        r.on('error', e => (abortAfter !== null ? resolve({ status: 0, aborted: true }) : reject(e)));
        let off = 0, paused = false;
        const CHUNK = 1 << 20;
        (function pump() {
          while (off < size) {
            if (pauseAt !== null && !paused && off >= pauseAt) { paused = true; return gate.then(pump); }
            const n = Math.min(CHUNK, size - off);
            const b = gen(off, n);
            hash.update(b);
            off += n;
            if (abortAfter !== null && off >= abortAfter) { r.write(b); return setTimeout(() => r.destroy(), 100); }
            const ok = r.write(b);
            if (chunkDelay) return setTimeout(pump, chunkDelay);
            if (!ok) return r.once('drain', pump);
          }
          r.end();
        })();
      });
    },
    // Downloads, hashing as it goes; nothing is written to disk.
    download(url, headers = {}) {
      return new Promise((resolve, reject) => {
        const r = request('GET', url, headers);
        r.on('response', res => {
          const hash = crypto.createHash('sha256'); let bytes = 0; let text = '';
          res.on('data', d => { bytes += d.length; if (res.statusCode >= 300) text += d; else hash.update(d); });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes, sha: hash.digest('hex'), json: res.statusCode >= 300 && text ? JSON.parse(text) : null }));
        });
        r.on('error', reject);
        r.end();
      });
    }
  };
  return c;
}

// Deterministic bytes for any offset, so a sender needs no source file and a range can be checked.
// A fixed 1 MiB block, with the MiB's number stamped in its first 8 bytes so no two MiB are alike.
const MIB = 1 << 20;
const BLOCK = (() => { const b = Buffer.alloc(MIB); let s = crypto.createHash('sha512').update('attic').digest(); for (let i = 0; i < MIB; i += 64) { s.copy(b, i); s = crypto.createHash('sha512').update(s).digest(); } return b; })();
function patternBytes(offset, n) {
  const b = Buffer.allocUnsafe(n);
  for (let done = 0; done < n;) {
    const p = offset + done, k = Math.floor(p / MIB), inBlock = p % MIB, take = Math.min(MIB - inBlock, n - done);
    const blk = Buffer.from(BLOCK.subarray(inBlock, inBlock + take));
    const stamp = Buffer.alloc(8); stamp.writeBigUInt64BE(BigInt(k));
    for (let i = inBlock; i < 8 && i - inBlock < take; i++) blk[i - inBlock] = stamp[i];
    blk.copy(b, done);
    done += take;
  }
  return b;
}
const shaOfPattern = (size, from = 0) => {
  const h = crypto.createHash('sha256');
  for (let off = from; off < size; off += 1 << 20) h.update(patternBytes(off, Math.min(1 << 20, size - off)));
  return h.digest('hex');
};

// A raw WebSocket client: messages queue until `next(type or test)` takes them.
function wsOpen(port, from, { query = '', cookie = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, headers);
    if (cookie) h.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, localAddress: from, path: '/api/hub' + query, headers: h });
    req.on('response', async res => { let t = ''; for await (const c of res) t += c; resolve({ refused: res.statusCode, body: JSON.parse(t) }); });
    req.on('upgrade', (res, socket, head) => {
      const messages = [], waiters = [];
      let closeCode = null; const closeWaiters = [];
      const parse = createParser(f => {
        if (f.opcode === OP.TEXT) {
          const m = JSON.parse(f.payload.toString('utf8'));
          const i = waiters.findIndex(w => w.test(m));
          if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else messages.push(m);
        } else if (f.opcode === OP.PING) socket.write(encode(OP.PONG, f.payload, true));
        else if (f.opcode === OP.CLOSE) { closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005; closeWaiters.forEach(r => r(closeCode)); }
      });
      if (head && head.length) setImmediate(() => parse(head));
      socket.on('data', d => parse(d));
      socket.on('error', () => {});
      resolve({
        socket, messages,
        send: obj => socket.write(encode(OP.TEXT, JSON.stringify(obj), true)),
        next(test, ms = 3000) {
          const fn = typeof test === 'function' ? test : m => m.type === test;
          const i = messages.findIndex(fn);
          if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
          return new Promise((res2, rej) => {
            const w = { test: fn, resolve: v => { clearTimeout(timer); res2(v); } };
            const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('no matching message in ' + ms + ' ms')); }, ms);
            waiters.push(w);
          });
        },
        close: () => { try { socket.write(encode(OP.CLOSE, Buffer.from([3, 232]), true)); } catch (e) { /* gone */ } socket.end(); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { startServer, stopServer, client, wsOpen, patternBytes, shaOfPattern, sleep };
