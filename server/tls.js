// tls.js — Phase 4, milestone 4-1: HTTPS that an iPhone trusts, with no certificate to buy and nothing
// to install on the HP.
//
// The HP makes its own small certificate authority, "Attic Hub CA", once (data/tls/), and with it a
// server certificate for its name and addresses. The iPhone trusts the CA once (a profile from
// /api/tls/profile.mobileconfig, then Settings → General → About → Certificate Trust Settings). After
// that, a new server certificate (the HP's address changed, or the old one is near its end) needs
// nothing from anyone.
//
// The CA carries name constraints: it can only vouch for this PC's own name, localhost and home-network
// addresses (10/8, 172.16/12, 192.168/16, 127/8). So even if its key were copied off the HP, it couldn't
// be used to impersonate any real website on a phone that trusts it.
//
// Apple's rules for a server certificate are met: ECDSA P-256 with SHA-256, the names in Subject
// Alternative Name, Extended Key Usage serverAuth, at most 397 days. Certificates are built here, in
// DER, and signed with node:crypto: no OpenSSL command needed. Core Node only.
'use strict';
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const CA_DAYS = 3650;
const LEAF_DAYS = 397;
const RENEW_DAYS = 30;
const HOME_RANGES = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8]];

// ---------- a little DER ----------
function len(n) {
  if (n < 128) return Buffer.from([n]);
  const b = []; for (let x = n; x > 0; x >>= 8) b.unshift(x & 255);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const ctx = (n, ...p) => tlv(0xa0 + n, ...p);          // [n] EXPLICIT / constructed
const ctxPrim = (n, b) => tlv(0x80 + n, b);             // [n] IMPLICIT, primitive
function int(b) { if (typeof b === 'number') b = Buffer.from([b]); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); }
const bool = v => tlv(0x01, [v ? 0xff : 0]);
const octet = b => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
function oid(s) {
  const p = s.split('.').map(Number), out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) { const b = []; let x = v; do { b.unshift(x & 127); x = Math.floor(x / 128); } while (x > 0); for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80; out.push(...b); }
  return tlv(0x06, out);
}
function time(d) {
  const z = n => String(n).padStart(2, '0');
  const s = `${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(z(d.getUTCFullYear() % 100) + s)) : tlv(0x18, Buffer.from(d.getUTCFullYear() + s));
}
const OID = { cn: '2.5.4.3', o: '2.5.4.10', ecdsaSha256: '1.2.840.10045.4.3.2', basic: '2.5.29.19', keyUsage: '2.5.29.15', eku: '2.5.29.37', serverAuth: '1.3.6.1.5.5.7.3.1',
  san: '2.5.29.17', ski: '2.5.29.14', aki: '2.5.29.35', nameConstraints: '2.5.29.30' };
const name = (cn, o) => seq(set(seq(oid(OID.o), utf8(o))), set(seq(oid(OID.cn), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));
const ipBytes = ip => net.isIPv4(ip) ? Buffer.from(ip.split('.').map(Number)) : null;
const maskBytes = bitsN => Buffer.from([0, 1, 2, 3].map(i => { const b = Math.max(0, Math.min(8, bitsN - i * 8)); return (0xff << (8 - b)) & 0xff; }));
// General names: a host name, or an IPv4 address.
const generalName = n => ipBytes(n) ? ctxPrim(7, ipBytes(n)) : ctxPrim(2, Buffer.from(n, 'ascii'));

function keyId(publicKey) {
  // SHA-1 of the public key's bits (RFC 5280's method 1), from the SPKI.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

function makeCert({ subject, issuer, publicKey, signingKey, days, extensions, now = new Date() }) {
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] |= 0x01;
  const notBefore = new Date(now.getTime() - 3600e3); // an hour's slack for clocks a little behind
  const notAfter = new Date(now.getTime() + days * 864e5);
  const alg = seq(oid(OID.ecdsaSha256));
  const tbs = seq(ctx(0, int(2)), int(serial), alg, issuer, seq(time(notBefore), time(notAfter)), subject,
    publicKey.export({ type: 'spki', format: 'der' }), ctx(3, seq(...extensions)));
  const sig = crypto.sign('sha256', tbs, signingKey);
  const der = seq(tbs, alg, bits(sig));
  return '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
}

// ---------- the HP's names ----------
// The names a phone might use to reach the HP: its PC name (plain and .local), localhost, and every
// home-network IPv4 address it has now. Link-local 169.254.* addresses belong to unconnected adapters.
function currentNames({ hostname = os.hostname(), interfaces = os.networkInterfaces(), extra = [] } = {}) {
  const ips = [];
  for (const list of Object.values(interfaces)) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.address.startsWith('169.254.') && inHome(a.address)) ips.push(a.address);
  }
  if (!ips.includes('127.0.0.1')) ips.push('127.0.0.1');
  const hosts = [hostname.toLowerCase(), hostname.toLowerCase() + '.local', 'localhost'].concat(extra.map(s => String(s).toLowerCase()));
  return [...new Set(hosts)].concat([...new Set(ips)].sort());
}
function inHome(ip) {
  const b = ipBytes(ip); if (!b) return false;
  const v = b.readUInt32BE(0);
  return HOME_RANGES.some(([base, n]) => ((v ^ ipBytes(base).readUInt32BE(0)) >>> 0) >>> (32 - n) === 0);
}

// A server certificate for `names`, signed by the CA. (Exported so the tests can also sign one the CA
// isn't allowed to vouch for, and check it's refused.)
function signServerCert({ caKeyPem, caPem, hostname, names, days = LEAF_DAYS }) {
  const ca = new crypto.X509Certificate(caPem);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const certPem = makeCert({ subject: name(hostname, 'Attic Hub'), issuer: name(`Attic Hub CA (${hostname})`, 'Attic Hub'), publicKey,
    signingKey: crypto.createPrivateKey(caKeyPem), days, extensions: [
      ext(OID.basic, true, seq()),
      ext(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),            // digitalSignature
      ext(OID.eku, false, seq(oid(OID.serverAuth))),
      ext(OID.san, false, seq(...names.map(generalName))),
      ext(OID.ski, false, octet(keyId(publicKey))),
      ext(OID.aki, false, seq(ctxPrim(0, keyId(ca.publicKey))))
    ] });
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem };
}

// ---------- the store ----------
function createTls(dataDir, { hostname = os.hostname(), extraNames = [], log = () => {}, interfaces } = {}) {
  const dir = path.join(dataDir, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  const f = n => path.join(dir, n);
  const write = (n, s, secret) => { fs.writeFileSync(f(n) + '.tmp', s, secret ? { mode: 0o600 } : undefined); fs.renameSync(f(n) + '.tmp', f(n)); };
  const read = n => { try { return fs.readFileSync(f(n), 'utf8'); } catch (e) { return null; } };

  // The CA: made once. Its constraints are fixed when it's made.
  let caKeyPem = read('ca-key.pem'), caPem = read('ca.pem');
  if (!caKeyPem || !caPem) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const subj = name(`Attic Hub CA (${hostname})`, 'Attic Hub');
    const hosts = [hostname.toLowerCase(), hostname.toLowerCase() + '.local', 'localhost'].concat(extraNames.map(s => String(s).toLowerCase()));
    const permitted = [...new Set(hosts)].map(h => seq(ctxPrim(2, Buffer.from(h, 'ascii'))))
      .concat(HOME_RANGES.map(([base, n]) => seq(ctxPrim(7, Buffer.concat([ipBytes(base), maskBytes(n)])))));
    caPem = makeCert({ subject: subj, issuer: subj, publicKey, signingKey: privateKey, days: CA_DAYS, extensions: [
      ext(OID.basic, true, seq(bool(true), int(0))),
      ext(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),            // keyCertSign, cRLSign
      ext(OID.ski, false, octet(keyId(publicKey))),
      ext(OID.nameConstraints, true, seq(ctx(0, ...permitted)))
    ] });
    caKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    write('ca-key.pem', caKeyPem, true);
    write('ca.pem', caPem);
    log(`Made the Attic Hub certificate authority (data/tls/ca.pem)`);
  }
  const ca = new crypto.X509Certificate(caPem);
  const caFingerprint = ca.fingerprint256;

  let leaf = null; // { keyPem, certPem, names, notAfter }
  function issue(names) {
    const { keyPem, certPem } = signServerCert({ caKeyPem, caPem, hostname, names });
    write('server-key.pem', keyPem, true);
    write('server.pem', certPem);
    write('server.json', JSON.stringify({ names }, null, 2));
    log(`Issued the HTTPS certificate for ${names.join(', ')}`);
    return load();
  }
  function load() {
    const certPem = read('server.pem'), keyPem = read('server-key.pem');
    let names = [];
    try { names = JSON.parse(read('server.json')).names; } catch (e) { /* none yet */ }
    if (!certPem || !keyPem) return (leaf = null);
    const x = new crypto.X509Certificate(certPem);
    if (!x.verify(ca.publicKey)) return (leaf = null); // not from this CA (the CA was replaced)
    return (leaf = { keyPem, certPem, names, notAfter: new Date(x.validTo) });
  }
  load();

  // Keeps the server certificate current: issued if missing, re-issued when the HP's names changed or
  // it's within 30 days of its end. Returns true if it changed.
  function refresh(now = Date.now()) {
    const names = currentNames({ hostname, interfaces: interfaces ? interfaces() : undefined, extra: extraNames });
    const same = leaf && leaf.names.length === names.length && names.every(n => leaf.names.includes(n));
    if (same && leaf.notAfter.getTime() - now > RENEW_DAYS * 864e5) return false;
    issue(names);
    return true;
  }
  refresh();

  return {
    refresh,
    get key() { return leaf.keyPem; },
    get cert() { return leaf.certPem; },
    caPem, caFingerprint,
    caDer: () => ca.raw,
    info: () => ({ caFingerprint, caName: ca.subject.replace(/\n/g, ', '), names: leaf.names, validUntil: leaf.notAfter.toISOString() }),
    // An iOS configuration profile holding the CA, so Safari offers to install it in one tap.
    profile() {
      const id = caFingerprint.replace(/:/g, '').toLowerCase();
      const uuid = s => { const h = crypto.createHash('sha256').update(s + id).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase(); };
      const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>attic-hub-ca.cer</string>
      <key>PayloadContent</key><data>${ca.raw.toString('base64')}</data>
      <key>PayloadDescription</key><string>Lets this device trust the Attic Hub server on ${esc(hostname)} over HTTPS. It can vouch only for that PC on your home network.</string>
      <key>PayloadDisplayName</key><string>${esc(`Attic Hub CA (${hostname})`)}</string>
      <key>PayloadIdentifier</key><string>com.sankethhegde.attichub.ca.${id.slice(0, 16)}</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid('ca')}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Trust the Attic Hub server on ${esc(hostname)} for HTTPS.</string>
  <key>PayloadDisplayName</key><string>Attic Hub (${esc(hostname)})</string>
  <key>PayloadIdentifier</key><string>com.sankethhegde.attichub.profile.${id.slice(0, 16)}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid('profile')}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
    }
  };
}

module.exports = { createTls, currentNames, inHome, signServerCert, LEAF_DAYS };
