// mail.js — feedback round 1: the HP sends email (password-reset links) through Gmail.
//
// The master sets it up once, on the HP: a Gmail address and an *app password* (Google Account →
// Security → 2-Step Verification → App passwords; a 16-letter password just for this, which can be
// revoked on its own). They're kept in data/mail.json, which is never in Git; the app password is
// never sent back by the API. Saving checks the address and password against Gmail first.
// A small SMTP client over TLS (port 465, as Gmail offers), in core Node: no mail library.
'use strict';
const tls = require('tls'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { AuthError, isEmail } = require('./auth');

const DEFAULTS = { host: 'smtp.gmail.com', port: 465 };
const TIMEOUT_MS = 20e3;

// One SMTP conversation: connect, EHLO, AUTH PLAIN, and then `steps` (may be none, to only check login).
function converse({ host, port, user, pass, ca, servername }, steps = []) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: servername || host, ca, minVersion: 'TLSv1.2' });
    let buf = '', waiting = null, done = false;
    const finish = (err, val) => { if (done) return; done = true; sock.end(); clearTimeout(timer); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => { finish(new Error('The mail server didn’t answer in time.')); sock.destroy(); }, TIMEOUT_MS);
    sock.setEncoding('utf8');
    // A reply is complete at a line whose 4th character is a space ("250 OK"), not a dash ("250-…").
    sock.on('data', d => {
      buf += d;
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1);
          buf = lines.slice(i + 1).join('\r\n');
          if (waiting) { const w = waiting; waiting = null; w(+lines[i].slice(0, 3), reply.join('\n')); }
          return;
        }
      }
    });
    sock.on('error', e => finish(new Error(`Couldn’t reach the mail server: ${e.message}`)));
    const expect = codes => new Promise((res, rej) => { waiting = (code, text) => codes.includes(code) ? res(text) : rej(Object.assign(new Error(text), { code })); });
    const send = (line, codes) => { const p = expect(codes); sock.write(line + '\r\n'); return p; };
    (async () => {
      await expect([220]);
      await send(`EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'attic-hub'}`, [250]);
      try { await send('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`).toString('base64'), [235]); }
      catch (e) { throw new AuthError(400, 'MAIL_LOGIN', 'Gmail refused the address or app password. Check both, and that 2-Step Verification is on for that account.'); }
      for (const [line, codes] of steps) await send(line, codes);
      await send('QUIT', [221]).catch(() => {});
      finish(null, true);
    })().catch(e => finish(e));
  });
}

// RFC 2047 for a header that may hold non-ASCII (a display name, a subject).
const encodeHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

function message({ from, fromName, to, subject, text }) {
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  return [
    `From: ${encodeHeader(fromName || 'Attic Hub')} <${from}>`, `To: <${to}>`, `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@attic-hub>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body
  ].join('\r\n');
}

function createMail(dataDir, { tlsOptions = {} } = {}) {
  const file = path.join(dataDir, 'mail.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
  const conn = c => Object.assign({ host: c.host, port: c.port, user: c.user, pass: c.pass }, tlsOptions);

  return {
    configured: () => !!read(),
    // What the master sees: never the app password.
    info() { const c = read(); return c ? { configured: true, user: c.user, host: c.host, port: c.port, savedAt: c.savedAt } : { configured: false }; },

    // Checks the address and app password with the mail server, then keeps them.
    async save({ user, appPassword, host = DEFAULTS.host, port = DEFAULTS.port } = {}) {
      const u = String(user || '').trim();
      if (!isEmail(u)) throw new AuthError(400, 'INVALID', 'Give the Gmail address the mail is sent from.');
      const pass = String(appPassword || '').replace(/\s+/g, ''); // Google shows it in groups of four
      if (pass.length < 8 || pass.length > 64) throw new AuthError(400, 'INVALID', 'Paste the app password Google gave you (16 letters).');
      const h = String(host || '').trim(), p = Number(port);
      if (!/^[a-zA-Z0-9.-]{1,253}$/.test(h) || !Number.isInteger(p) || p < 1 || p > 65535) throw new AuthError(400, 'INVALID', 'Bad mail server or port.');
      await converse(conn({ host: h, port: p, user: u, pass }));
      const c = { user: u, pass, host: h, port: p, savedAt: new Date().toISOString() };
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(c, null, 2), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      return this.info();
    },
    forget() { fs.rmSync(file, { force: true }); },

    async send({ to, subject, text }) {
      const c = read();
      if (!c) throw new AuthError(409, 'MAIL_OFF', 'Email isn’t set up on the HP.');
      if (!isEmail(to)) throw new AuthError(400, 'INVALID', 'No email address to send to.');
      // Lines starting with "." are doubled (SMTP's end-of-message mark); base64 bodies have none anyway.
      const data = message({ from: c.user, to, subject, text }).split('\r\n').map(l => l.startsWith('.') ? '.' + l : l).join('\r\n');
      await converse(conn(c), [[`MAIL FROM:<${c.user}>`, [250]], [`RCPT TO:<${to}>`, [250, 251]], ['DATA', [354]], [data + '\r\n.', [250]]]);
      return true;
    }
  };
}

module.exports = { createMail, DEFAULTS };
