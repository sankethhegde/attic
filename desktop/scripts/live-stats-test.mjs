// Phase 2, 2-3 end-to-end test: live stats in the real desktop tool, against a throwaway copy of server/
// with pairing required (port 8085). The tool pairs through this PC's network address, so its agent
// reports to the hub as a client PC would. The test plays the HP's master on 127.0.0.1, and a second
// device (a stand-in ROG Ally) whose agent it runs itself.
// Usage (from desktop/): node scripts/live-stats-test.mjs [path-to-exe]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const HTTP_PORT = 8085, CDP_PORT = 9345;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-2-3-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;

fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  pairing: { required: true, trustThisPC: true },
  shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }),
  stdio: 'ignore'
});

// The test as the HP (127.0.0.1, no pairing needed), or `from` this PC's network address as another device.
let masterCookie = '';
function hp(method, url, body, from) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: from ? LAN : '127.0.0.1', localAddress: from ? LAN : undefined, port: HTTP_PORT, path: url, method,
      headers: Object.assign({ Cookie: from ? '' : masterCookie }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        const set = res.headers['set-cookie'] || [];
        if (!from && set.length) masterCookie = set.map(c => c.split(';')[0]).filter(c => /^attic_session=/.test(c)).join('; ') || masterCookie;
        let json = null; try { json = JSON.parse(s); } catch {}
        resolve({ status: res.statusCode, body: json, cookies: set });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---- the desktop tool, driven over the DevTools protocol ----
const profile = path.join(tmp, 'profile');
let tool = null, ws = null, id = 0;
const pending = {};
async function launchTool() {
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`];
  tool = exe ? spawn(exe, args, { stdio: 'ignore' })
    : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
}
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await Promise.race([send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }), sleep(20000).then(() => null)]);
  if (!r) return 'TIMEOUT';
  return r.result.exceptionDetails ? 'ERR ' + (r.result.exceptionDetails.exception?.description || '') : r.result.result.value;
};
async function waitFor(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await ev(`try { return (${cond}) || null; } catch (e) { return null; }`).catch(() => null);
    if (v && v !== 'TIMEOUT' && !String(v).startsWith('ERR')) return v;
    await sleep(250);
  }
  return null;
}
function quitTool() { try { ws.close(); } catch {} try { tool.kill(); } catch {} }
const card = name => `[...document.querySelectorAll('.hub-card')].find(c => c.querySelector('.nm').textContent === ${JSON.stringify(name)})`;
let ally = null;

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  check('throwaway server starts', up, `tool connects via ${LAN}:${HTTP_PORT}`);
  const hello = (await hp('GET', '/api/hello')).body;
  await hp('POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  await hp('POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });

  // 1. Pair the tool; its agent should start reporting without anything else.
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: hello.name, address: LAN, port: HTTP_PORT }));
  await launchTool();
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-name') && document.querySelector('#pr-name').value`, 20000);
  const code = (await hp('POST', '/api/pairing/codes', {})).body.code;
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  const paired = await waitFor(`location.hash === '#/login' && 'paired'`);
  check('the tool pairs with a code', paired, paired || await ev(`return location.hash + ' ' + (document.querySelector('.field-msg:not(:empty)') || {}).textContent`));
  const t0 = Date.now();
  let me = null;
  for (let i = 0; i < 40 && !(me && me.stats); i++) {
    me = ((await hp('GET', '/api/devices')).body || []).find(d => d.role === 'client');
    if (!(me && me.stats)) await sleep(250);
  }
  const s = me && me.stats;
  check('after pairing, the tool’s agent reports to the HP by itself', s, s ? `first report in ${Date.now() - t0} ms` : JSON.stringify(me));
  check('the report has every stat, in range', s && s.cpu >= 0 && s.cpu <= 100 && s.ramUsed <= s.ramTotal && s.diskFree <= s.diskTotal && s.diskTotal > 0,
    s && `CPU ${s.cpu}% · RAM ${(s.ramUsed / 1e9).toFixed(1)}/${(s.ramTotal / 1e9).toFixed(1)} GB · disk ${(s.diskFree / 1e9).toFixed(0)} GB free of ${(s.diskTotal / 1e9).toFixed(0)}`);
  check('battery and network come from systeminformation', me && (s.battery === null || (s.battery >= 0 && s.battery <= 100)) && me.connection && me.ip === LAN,
    me && `battery ${s.battery === null ? 'none' : s.battery + '%' + (s.charging ? ', charging' : '')} · ${me.connection} · ${me.ip}`);
  check('the HP shows it online with an agent', me && me.online && !me.browserOnly, me && `online ${me.online}, browserOnly ${me.browserOnly}`);

  // 2. Sign in as master in the tool: Settings says the agent is reporting; Devices is live.
  await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  await ev(`location.hash = '#/settings'; return 1`);
  const agentRow = await waitFor(`document.querySelector('#srv-agent') && !document.querySelector('#srv-agent .skel') && document.querySelector('#srv-agent').textContent`);
  check('Settings → Server shows the agent sending', agentRow === 'Sending to the HP', agentRow);
  await ev(`location.hash = '#/devices'; return 1`);
  const live = await waitFor(`document.querySelector('#live.on') && document.querySelector('#live').textContent`);
  check('the Devices view goes live over the hub', live === 'Live', live || await ev(`return document.querySelector('#live') && document.querySelector('#live').textContent`));
  const myName = os.hostname().slice(0, 64);
  const meters = await waitFor(`(() => { const c = [...document.querySelectorAll('.hub-card')].find(c => /This device/.test(c.textContent)); return c && c.querySelectorAll('.stat').length === 4 && [...c.querySelectorAll('.stat .v')].map(v => v.textContent).join(' | '); })()`);
  check('this PC’s card shows CPU, RAM, disk and battery', meters, meters);
  const hpMeters = await waitFor(`(() => { const c = [...document.querySelectorAll('.hub-card')].find(c => c.querySelector('.tag-ok')); return c && c.querySelectorAll('.stat').length === 4 && [...c.querySelectorAll('.stat .v')].map(v => v.textContent).join(' | '); })()`, 10000);
  check('the HP’s card shows its own stats', hpMeters, hpMeters);
  const polls = await ev(`return performance.getEntriesByType('resource').filter(e => e.name.endsWith('/api/devices')).length`);
  await sleep(6000);
  const polls2 = await ev(`return performance.getEntriesByType('resource').filter(e => e.name.endsWith('/api/devices')).length`);
  check('no polling while live', polls2 === polls, `${polls} → ${polls2} requests to /api/devices in 6 s`);

  // 3. A second device's agent: its stats reach the master's view within 5 s, and going offline shows.
  const allyCode = (await hp('POST', '/api/pairing/codes', {})).body.code;
  const claim = await hp('POST', '/api/pairing/claim', { code: allyCode, name: 'ROG Ally', kind: 'handheld', os: 'Windows 11' }, true);
  const token = (claim.cookies.find(c => c.startsWith('attic_device=')) || '').split(';')[0].split('=')[1];
  ally = new WebSocket(`ws://${LAN}:${HTTP_PORT}/api/hub?role=agent`, { headers: { 'X-Attic-Device': token } });
  const helloMsg = await new Promise(r => { ally.onmessage = m => r(JSON.parse(m.data)); setTimeout(() => r(null), 5000); });
  check('a second agent is welcomed with the interval to use', helloMsg && helloMsg.type === 'hello' && helloMsg.interval === 3000, JSON.stringify(helloMsg));
  const allyCard = await waitFor(`${card('ROG Ally')} && ${card('ROG Ally')}.textContent`, 5000);
  check('the new device appears without a reload', allyCard, allyCard ? 'card added' : 'no card');
  const report = n => ally.send(JSON.stringify({ type: 'stats', stats: { cpu: 31, ramTotal: 16e9, ramUsed: 9.4e9, diskTotal: 512e9, diskFree: 96e9, battery: n, charging: false }, connection: 'wifi', ip: '192.168.1.31' }));
  let tSent = Date.now();
  report(41);
  const shown = await waitFor(`${card('ROG Ally')} && /41%/.test(${card('ROG Ally')}.textContent) && 'shown'`, 5000);
  check('a report reaches the master’s Devices view within 5 s', shown, shown ? `${Date.now() - tSent} ms` : 'not within 5 s');
  await sleep(1100);
  tSent = Date.now();
  report(12);
  const crit = await waitFor(`${card('ROG Ally')} && /12%/.test(${card('ROG Ally')}.textContent) && ${card('ROG Ally')}.querySelector('.meter.crit') && 'low'`, 5000);
  check('a change shows within 5 s, with the low-battery colour', crit, crit ? `${Date.now() - tSent} ms` : 'not shown');
  ally.close();
  tSent = Date.now();
  const off = await waitFor(`${card('ROG Ally')} && /Offline/.test(${card('ROG Ally')}.textContent) && ${card('ROG Ally')}.querySelector('.stats.stale') && /Last reported/.test(${card('ROG Ally')}.textContent) && 'offline'`, 5000);
  check('when its agent stops, the card goes offline with the last figures greyed', off, off ? `${Date.now() - tSent} ms` : await ev(`return ${card('ROG Ally')} && ${card('ROG Ally')}.textContent.slice(0, 200)`));

  // 4. Unpaired on the HP: the tool's agent is cut off and stops; the tool returns to pairing.
  const myId = (await hp('GET', '/api/devices')).body.find(d => d.role === 'client' && d.name === myName).id;
  await hp('DELETE', '/api/devices/' + myId, {});
  const back = await waitFor(`location.hash === '#/pair' && 'pairing screen'`, 10000);
  await sleep(500);
  const state = await ev(`return (await atticDesktop.server.current() || {}).agent`);
  check('unpairing stops the agent and the tool asks to pair again', back && state !== 'reporting' && state !== 'connecting', `${back || 'no pairing screen'} · agent ${state}`);
} catch (e) {
  check('test ran to the end', false, e.stack || e.message);
} finally {
  try { ally && ally.close(); } catch {}
  quitTool();
  try { server.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
