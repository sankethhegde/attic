// HTTPS tests (Phase 4, milestone 4-1): the HP serves its interface over HTTPS with a certificate from
// its own small certificate authority, which an iPhone trusts once through a profile. The CA can vouch
// only for this PC and home-network addresses. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http'), https = require('https'), net = require('net');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, stopServer, sleep } = require('./test-util');
const { createTls, signServerCert, currentNames, LEAF_DAYS } = require('./tls');
const { encode, createParser, OP } = require('./ws');

const PORT = 29000 + Math.floor(Math.random() * 500);
const HTTPS_PORT = PORT + 500;
const MASTER = { displayName: 'Sanketh', username: 'sanketh', password: 'master-pass-1' };
let tmp, server, env, caPem;

function req(proto, method, url, { body, headers = {}, ca, servername, port } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (data) Object.assign(h, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    const mod = proto === 'https' ? https : http;
    const r = mod.request({ host: '127.0.0.1', port: port || (proto === 'https' ? HTTPS_PORT : PORT), method, path: url, headers: h, ca, servername }, async res => {
      const chunks = []; for await (const c of res) chunks.push(c);
      const buf = Buffer.concat(chunks);
      let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not JSON */ }
      resolve({ status: res.statusCode, headers: res.headers, buf, json });
    });
    r.on('error', reject);
    r.end(data);
  });
}
const derToPem = der => '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-https-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }));
  env = { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_HTTPS_PORT: String(HTTPS_PORT) };
  server = await startServer(env);
  await req('http', 'POST', '/api/setup', { body: MASTER });
});
test.after(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- getting the phone to trust the HP ----------
test('over plain http, anyone can learn where HTTPS is and fetch the CA, as a certificate and as an iPhone profile', async () => {
  const info = (await req('http', 'GET', '/api/tls')).json;
  assert.strictEqual(info.httpsPort, HTTPS_PORT);
  assert.match(info.caFingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  for (const n of ['localhost', '127.0.0.1', os.hostname().toLowerCase(), os.hostname().toLowerCase() + '.local']) assert.ok(info.names.includes(n), n);
  assert.deepStrictEqual([info.caUrl, info.profileUrl], ['/api/tls/ca.cer', '/api/tls/profile.mobileconfig']);
  const cer = await req('http', 'GET', '/api/tls/ca.cer');
  assert.strictEqual(cer.headers['content-type'], 'application/x-x509-ca-cert');
  const ca = new crypto.X509Certificate(cer.buf);
  assert.strictEqual(ca.fingerprint256, info.caFingerprint);
  assert.ok(ca.ca, 'a CA certificate');
  caPem = derToPem(cer.buf);
  const prof = await req('http', 'GET', '/api/tls/profile.mobileconfig');
  assert.strictEqual(prof.headers['content-type'], 'application/x-apple-aspen-config');
  const xml = prof.buf.toString('utf8');
  assert.ok(xml.includes('<string>com.apple.security.root</string>'));
  assert.ok(xml.includes(`<data>${cer.buf.toString('base64')}</data>`), 'the same CA inside');
  assert.strictEqual((await req('http', 'GET', '/api/tls/profile.mobileconfig')).buf.toString('utf8'), xml, 'the same profile every time');
  // Nothing private is reachable.
  for (const p of ['/api/tls/ca-key.pem', '/api/tls/server-key.pem']) assert.strictEqual((await req('http', 'GET', p)).status, 404, p);
});

test('a device that trusts the CA gets the interface over HTTPS; one that doesn’t is refused', async () => {
  const ok = await req('https', 'GET', '/api/hello', { ca: caPem });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.app, 'Attic');
  assert.strictEqual(ok.json.serverId, (await req('http', 'GET', '/api/hello')).json.serverId, 'the same server on both');
  assert.strictEqual((await req('https', 'GET', '/', { ca: caPem })).status, 200, 'the interface itself');
  await assert.rejects(req('https', 'GET', '/api/hello'), /self-signed|unable to get local issuer|certificate/i, 'untrusted without the CA');
  for (const servername of ['localhost', os.hostname().toLowerCase() + '.local']) assert.strictEqual((await req('https', 'GET', '/api/hello', { ca: caPem, servername })).status, 200, servername);
});

test('the server certificate meets Apple’s rules', async () => {
  const cert = await new Promise((resolve, reject) => {
    const s = require('tls').connect({ host: '127.0.0.1', port: HTTPS_PORT, ca: caPem }, () => { resolve(s.getPeerX509Certificate()); s.end(); });
    s.on('error', reject);
  });
  const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 864e5;
  assert.ok(days <= 398, `at most 398 days, got ${days.toFixed(1)}`);
  assert.ok(cert.subjectAltName.includes('DNS:localhost') && cert.subjectAltName.includes('IP Address:127.0.0.1'));
  assert.ok(cert.keyUsage.includes('1.3.6.1.5.5.7.3.1'), 'serverAuth');
  assert.strictEqual(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.strictEqual(cert.ca, false);
  assert.ok(cert.checkIssued(new crypto.X509Certificate(caPem)));
});

test('the CA can’t vouch for anything but this PC and the home network, even with its own key', async () => {
  const caKeyPem = fs.readFileSync(path.join(tmp, 'data', 'tls', 'ca-key.pem'), 'utf8');
  for (const [names, servername, host] of [[['example.com'], 'example.com'], [['www.apple.com'], 'www.apple.com'], [['8.8.8.8'], undefined, '8.8.8.8']]) {
    // Properly chained to the real CA (same issuer name, signed with its key): only the names are wrong.
    const rogue = signServerCert({ caKeyPem, caPem, hostname: os.hostname(), names });
    const s = https.createServer({ key: rogue.keyPem, cert: rogue.certPem }, (q, r) => r.end('should not be reached')).listen(0, '127.0.0.1');
    await new Promise(r => s.once('listening', r));
    const err = await new Promise(resolve => {
      const c = https.get({ host: '127.0.0.1', port: s.address().port, ca: caPem, servername, checkServerIdentity: (h, cert) => host && !cert.subjectaltname.includes(host) ? new Error('no') : undefined },
        res => { res.resume(); resolve(null); });
      c.on('error', resolve);
    });
    s.close();
    assert.ok(err, `refused for ${names}`);
    assert.match(err.code + ' ' + err.message, /permitted subtree violation|name constraint|PERMITTED_VIOLATION/i, `${names}: ${err.code} ${err.message}`);
  }
});

// ---------- the rest of the server, over HTTPS ----------
test('over HTTPS, sign-in cookies are Secure, and a request must come from the HTTPS origin', async () => {
  const r = await req('https', 'POST', '/api/session', { ca: caPem, body: Object.assign({ mode: 'master' }, MASTER) });
  assert.strictEqual(r.status, 200);
  const cookie = r.headers['set-cookie'].find(c => c.startsWith('attic_session='));
  assert.match(cookie, /; Secure/);
  const plain = await req('http', 'POST', '/api/session', { body: Object.assign({ mode: 'master' }, MASTER) });
  assert.ok(!/; Secure/.test(plain.headers['set-cookie'].find(c => c.startsWith('attic_session='))), 'not over plain http, which the desktop tool uses');
  const sess = cookie.split(';')[0];
  assert.strictEqual((await req('https', 'POST', '/api/accounts', { ca: caPem, headers: { Cookie: sess, Origin: `https://127.0.0.1:${HTTPS_PORT}` },
    body: { displayName: 'Phone', username: 'phone', password: 'phone-pass-1', deviceType: 'phone' } })).status, 201);
  assert.strictEqual((await req('https', 'POST', '/api/accounts', { ca: caPem, headers: { Cookie: sess, Origin: `http://127.0.0.1:${HTTPS_PORT}` },
    body: { displayName: 'X', username: 'xx-x', password: 'phone-pass-1' } })).json.code, 'FORBIDDEN', 'an http origin on the https server is another site');
  // The live hub works over wss:// too.
  const first = await new Promise((resolve, reject) => {
    const q = https.request({ host: '127.0.0.1', port: HTTPS_PORT, ca: caPem, path: '/api/hub', headers: { Cookie: sess, Origin: `https://127.0.0.1:${HTTPS_PORT}`,
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
    q.on('upgrade', (res, socket, head) => {
      const parse = createParser(f => { if (f.opcode === OP.TEXT) { resolve(JSON.parse(f.payload.toString('utf8'))); socket.end(encode(OP.CLOSE, Buffer.from([3, 232]), true)); } });
      if (head.length) parse(head);
      socket.on('data', parse);
    });
    q.on('response', res => reject(new Error('refused ' + res.statusCode)));
    q.on('error', reject);
    q.end();
  });
  assert.strictEqual(first.type, 'devices');
});

test('pairing hands the device the CA’s fingerprint, so it can pin the HP', async () => {
  const sess = (await req('http', 'POST', '/api/session', { body: Object.assign({ mode: 'master' }, MASTER) })).headers['set-cookie'].find(c => c.startsWith('attic_session=')).split(';')[0];
  const code = (await req('http', 'POST', '/api/pairing/codes', { body: {}, headers: { Cookie: sess } })).json.code;
  // Another machine (127.0.0.2) pairs.
  const claim = await new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ code, name: 'iPhone', kind: 'phone' }));
    const r = http.request({ host: '127.0.0.1', port: PORT, localAddress: '127.0.0.2', method: 'POST', path: '/api/pairing/claim',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, async res => { let t = ''; for await (const c of res) t += c; resolve(JSON.parse(t)); });
    r.on('error', reject); r.end(data);
  });
  assert.strictEqual(claim.tls.caFingerprint, new crypto.X509Certificate(caPem).fingerprint256);
  assert.strictEqual(claim.tls.httpsPort, HTTPS_PORT);
});

test('a web app manifest is served as one, for the Home Screen app', async () => {
  const f = path.join(__dirname, '..', 'ui', 'attic-test.webmanifest');
  fs.writeFileSync(f, '{"name":"Attic"}');
  try { assert.strictEqual((await req('http', 'GET', '/attic-test.webmanifest')).headers['content-type'], 'application/manifest+json'); }
  finally { fs.rmSync(f, { force: true }); }
});

test('with the HTTPS port taken, the server still starts over http and says so', async () => {
  const blocker = net.createServer().listen(HTTPS_PORT + 1, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  const port2 = PORT + 1;
  const s2 = await startServer(Object.assign({}, env, { ATTIC_PORT: String(port2), ATTIC_HTTPS_PORT: String(HTTPS_PORT + 1) }));
  try {
    assert.strictEqual((await req('http', 'GET', '/api/hello', { port: port2 })).status, 200);
    assert.strictEqual((await req('http', 'GET', '/api/tls', { port: port2 })).json.httpsPort, null);
  } finally { await stopServer(s2); blocker.close(); }
});

// ---------- the certificate store on its own ----------
test('the server certificate follows the HP’s addresses and renews before its end; the CA never changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-tls-unit-'));
  try {
    let addrs = ['192.168.1.12'];
    const interfaces = () => ({ 'Wi-Fi 2': addrs.map(address => ({ family: 'IPv4', address, internal: false })), Ethernet: [{ family: 'IPv4', address: '169.254.10.1', internal: false }] });
    const t = createTls(dir, { hostname: 'DESKTOP-TEST', interfaces });
    const fp = t.caFingerprint;
    assert.deepStrictEqual(t.info().names, ['desktop-test', 'desktop-test.local', 'localhost', '127.0.0.1', '192.168.1.12'], 'no link-local address');
    assert.strictEqual(t.refresh(), false, 'nothing changed');
    addrs = ['192.168.1.3']; // the router handed out a new address
    assert.strictEqual(t.refresh(), true);
    assert.ok(new crypto.X509Certificate(t.cert).subjectAltName.includes('IP Address:192.168.1.3'));
    assert.strictEqual(t.caFingerprint, fp, 'the phone doesn’t have to trust anything new');
    assert.strictEqual(t.refresh(Date.now() + (LEAF_DAYS - 20) * 864e5), true, 'renewed in its last 30 days');
    // Restarting reuses what's on disk.
    const again = createTls(dir, { hostname: 'DESKTOP-TEST', interfaces });
    assert.strictEqual(again.caFingerprint, fp);
    assert.strictEqual(again.cert, t.cert);
    // Addresses outside home ranges aren't put in the certificate (the CA couldn't vouch for them).
    assert.ok(!currentNames({ hostname: 'x', interfaces: { a: [{ family: 'IPv4', address: '100.64.1.2' }] } }).includes('100.64.1.2'));
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
