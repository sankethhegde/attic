// ws.js — Phase 2, milestone 2-3: the smallest WebSocket (RFC 6455) the hub needs, in core Node.
// Text frames of JSON only, at most 64 KB, never fragmented; ping/pong and close are handled. Anything
// else (binary, fragments, an unmasked client frame, oversize) closes the connection with the code the
// RFC gives for it. The frame helpers are exported for the tests, which play the client.
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;
const OP = { CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

// One frame. Clients must mask what they send; servers must not.
function encode(opcode, payload, mask = false) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
  const len = data.length;
  const head = [0x80 | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 255);
  else { head.push(m | 127, 0, 0, 0, 0); for (let i = 3; i >= 0; i--) head.push((len >>> (i * 8)) & 255); }
  if (!mask) return Buffer.concat([Buffer.from(head), data]);
  const key = crypto.randomBytes(4);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), key, body]);
}

// Feeds bytes in, calls onFrame({ fin, opcode, masked, payload }) per whole frame. Throws { code } on a
// frame the hub won't take.
function createParser(onFrame, { maxPayload = MAX_PAYLOAD } = {}) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), opcode = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
      if (buf[0] & 0x70) throw { code: 1002 }; // no extensions were agreed
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) throw { code: 1009 };
        len = buf.readUInt32BE(6); off = 10;
      }
      if (len > maxPayload) throw { code: 1009 };
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const key = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      buf = buf.subarray(need);
      onFrame({ fin, opcode, masked, payload });
    }
  };
}

// The server's end of one connection. Emits 'message' (parsed JSON), 'pong' and 'close'.
class Connection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.lastPong = Date.now();
    const parse = createParser(f => this._frame(f));
    socket.setNoDelay(true);
    socket.on('data', chunk => {
      try { parse(chunk); } catch (e) { this.close(e.code || 1002); }
    });
    // The HTTP server keeps sockets half-open, so a client that just goes away shows up as 'end' only.
    socket.on('end', () => this._ended());
    socket.on('close', () => this._ended());
    socket.on('error', () => this._ended());
  }
  _frame({ fin, opcode, masked, payload }) {
    if (!this.open) return;
    if (!masked) return this.close(1002);
    if (opcode === OP.PING) return this._write(encode(OP.PONG, payload));
    if (opcode === OP.PONG) { this.lastPong = Date.now(); return this.emit('pong'); }
    if (opcode === OP.CLOSE) return this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
    if (!fin || opcode !== OP.TEXT) return this.close(1003);
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { return this.close(1007); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.close(1007);
    this.emit('message', msg);
  }
  _write(b) { if (this.open && !this.socket.destroyed) this.socket.write(b); }
  send(obj) { this._write(encode(OP.TEXT, JSON.stringify(obj))); }
  ping() { this._write(encode(OP.PING, '')); }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0); body.write(reason, 2);
    this._write(encode(OP.CLOSE, body));
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.emit('close', code);
  }
  _ended() {
    if (this.open) { this.open = false; this.emit('close', 1006); }
    this.socket.destroy();
  }
}

// Completes the handshake for an HTTP 'upgrade' request, or returns null if it isn't a valid one.
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' ||
      !key || Buffer.from(key, 'base64').length !== 16) return null;
  const hash = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`);
  return new Connection(socket);
}

// Refuses an upgrade with an ordinary HTTP answer, so the client can read why.
function refuse(socket, status, body) {
  const text = JSON.stringify(body);
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' }[status] || 'Error';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
}

module.exports = { accept, refuse, encode, createParser, OP, MAX_PAYLOAD };
