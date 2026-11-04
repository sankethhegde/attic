// Tests for agent/mode.js and the parts of agent/server-control.js that need no Windows task.
// Run: node --test "agent/*.test.js". desktop/scripts/mode-test.mjs runs the real tool in both modes.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mode = require('./mode.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'attic-mode-'));

test('the chosen mode is kept, and anything else reads as not chosen yet', () => {
  const file = path.join(tmp(), 'mode.json');
  const s = mode.store(file);
  assert.strictEqual(s.load(), null);
  s.save({ mode: 'server', server: { dir: 'C:\\x' } });
  assert.strictEqual(mode.store(file).load().mode, 'server');
  fs.writeFileSync(file, '{"mode":"banana"}');
  assert.strictEqual(s.load(), null);
  s.forget();
  assert.strictEqual(s.load(), null);
});

test('a new server gets one share per folder, with safe ids', () => {
  const cfg = mode.newConfig({ shares: [{ name: 'Main storage', rootPath: 'D:\\Shared' }, { name: 'Main storage', rootPath: 'E:\\More', deviceType: 'external' }] });
  assert.deepStrictEqual(cfg.shares.map(s => s.id), ['main-storage', 'main-storage-2']);
  assert.strictEqual(cfg.shares[1].deviceType, 'external');
  assert.strictEqual(cfg.port, 8080);
  assert.deepStrictEqual(cfg.pairing, { required: true, trustThisPC: true });
  assert.throws(() => mode.newConfig({ shares: [] }), /at least one folder/);
  assert.throws(() => mode.newConfig({ shares: [{ rootPath: 'Shared' }] }), /full folder path/);
  assert.throws(() => mode.newConfig({ shares: [{ rootPath: 'D:\\S' }], port: 80 }), /1024 to 65535/);
});

test('creating a server writes config.json and the folders, and never overwrites', () => {
  const dir = path.join(tmp(), 'server'), store = path.join(tmp(), 'Attic storage');
  const p = mode.createServer(dir, { shares: [{ name: 'Main', rootPath: store }], port: 8099 });
  assert.ok(fs.existsSync(store) && fs.existsSync(p.data));
  assert.strictEqual(JSON.parse(fs.readFileSync(p.config, 'utf8')).port, 8099);
  assert.throws(() => mode.createServer(dir, { shares: [{ rootPath: store }] }), /already exists/);
});

test('an existing server folder is checked, and the repository root is accepted too', () => {
  const repo = tmp(), dir = path.join(repo, 'server');
  assert.throws(() => mode.checkExisting(repo), /no config.json/);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ nope');
  assert.throws(() => mode.checkExisting(dir), /isn’t valid JSON/);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 8080, shares: [] }));
  assert.throws(() => mode.checkExisting(dir), /no shares/);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 8081, shares: [{ id: 'm', rootPath: 'D:\\S' }] }));
  fs.writeFileSync(path.join(dir, 'data', 'accounts.json'), '[]');
  const p = mode.checkExisting(repo);
  assert.strictEqual(p.dir, dir);
  assert.deepStrictEqual([p.port, p.shares, p.hasData], [8081, 1, true]);
});

test('status reads a stopped server as stopped, without touching Windows tasks', async () => {
  const { createControl } = require('./server-control.js');
  const dir = path.join(tmp(), 'server');
  const p = mode.createServer(dir, { shares: [{ rootPath: path.join(tmp(), 's') }], port: 8097 });
  const fakeService = { TASK: 'Attic Hub Server (test)', taskInfo: () => null, installScript: () => '' };
  const c = createControl({ paths: p, service: fakeService, exe: process.execPath, supervisor: 'supervisor.js', workDir: dir });
  const st = await c.status();
  assert.deepStrictEqual([st.port, st.task, st.supervisor, st.server], [8097, null, null, null]);
  await assert.rejects(c.start(), /isn’t installed/);
  assert.deepStrictEqual(c.logs(), []);
});

test('a task that runs this tool is recognised as ours; one from the repository isn’t', async () => {
  const { createControl } = require('./server-control.js');
  const p = mode.createServer(path.join(tmp(), 'server'), { shares: [{ rootPath: path.join(tmp(), 's') }], port: 8096 });
  const exe = 'C:\\Program Files\\Attic Hub\\Attic Hub.exe', supervisor = 'C:\\Program Files\\Attic Hub\\resources\\server\\service\\supervisor.js';
  const withAction = action => ({ TASK: 'Attic Hub Server', installScript: () => '', taskInfo: () => ({ state: 'Running', user: 'PC\\me', action }) });
  const ours = createControl({ paths: p, service: withAction(`${exe} "${supervisor}"`), exe, supervisor, workDir: '.' });
  assert.deepStrictEqual([(await ours.status()).task.ours, (await ours.status()).task.state], [true, 'running']);
  const repo = createControl({ paths: p, service: withAction('C:\\Program Files\\nodejs\\node.exe "C:\\Users\\HP\\attic\\server\\service\\supervisor.js"'), exe, supervisor, workDir: '.' });
  assert.strictEqual((await repo.status()).task.ours, false);
});
