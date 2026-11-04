// uploader.js — Phase 3, milestone 3-3 (T-06): send files to a device by their paths on this PC.
//
// Files picked in File Explorer ("Send to Attic Hub") arrive as paths, which the interface's page can't
// read, so the tool's main process sends them: the same two steps as the Send dialog (2-4), POST
// /api/transfers then PUT the file, streamed from disk, with the window's own sign-in (its cookies).
// Also gathers the files under a picked folder, since a transfer carries one file. Core Node only.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const MAX_FILES = 1000; // in one folder pick

// Paths from Explorer → [{ path, name, size, group }]: a folder becomes its files (group = its name).
async function expand(paths) {
  const out = [];
  async function walk(dir, group) {
    for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p, group);
      else if (ent.isFile()) out.push({ path: p, name: ent.name, size: (await fs.promises.stat(p)).size, group });
    }
  }
  for (const p of paths) {
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { continue; }
    if (st.isDirectory()) await walk(p, path.basename(p));
    else if (st.isFile()) out.push({ path: p, name: path.basename(p), size: st.size, group: null });
  }
  return out;
}

function request(base, method, url, { cookie, json, body, size, onData }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, base);
    const headers = { Cookie: cookie || '' };
    if (json !== undefined) { const d = Buffer.from(JSON.stringify(json)); Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': d.length }); body = d; }
    else if (size != null) Object.assign(headers, { 'Content-Type': 'application/octet-stream', 'X-Attic-Upload': '1', 'Content-Length': size });
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let s = ''; res.on('data', c => { s += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (e) { /* not JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(Object.assign(new Error((j && j.message) || `The HP answered ${res.statusCode}.`), { code: j && j.code }));
      });
    });
    req.on('error', () => reject(Object.assign(new Error('Couldn’t reach the HP.'), { code: 'UNREACHABLE' })));
    if (body && typeof body.pipe === 'function') {
      body.on('data', c => onData && onData(c.length));
      body.on('error', e => req.destroy(e));
      body.pipe(req);
    } else req.end(body);
    request.last = req;
  });
}

// Sends `files` ([{ path, name, size }]) to device `to`, one after another.
// → { promise (the transfers, queued on the HP), cancel }.
function send({ base, cookie, files, to, onProgress = () => {}, onSent = () => {} }) {
  let cancelled = false, current = null, req = null;
  const total = files.reduce((a, f) => a + f.size, 0);
  const promise = (async () => {
    const out = [];
    let done = 0;
    for (const f of files) {
      if (cancelled) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      const size = (await fs.promises.stat(f.path)).size; // as it is now, in case it changed
      current = await request(base, 'POST', '/api/transfers', { cookie, json: { to, fileName: f.name, size } });
      let sent = 0;
      const p = request(base, 'PUT', `/api/transfers/${encodeURIComponent(current.id)}/file`, { cookie, size, body: fs.createReadStream(f.path),
        onData: n => { sent += n; onProgress({ name: f.name, loaded: done + sent, total }); } });
      req = request.last;
      out.push(await p);
      onSent(current.id, f);
      current = null;
      done += f.size;
    }
    return out;
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      if (req) req.destroy();
      if (current) request(base, 'DELETE', `/api/transfers/${encodeURIComponent(current.id)}`, { cookie, json: {} }).catch(() => {});
    }
  };
}

module.exports = { expand, send, MAX_FILES };
