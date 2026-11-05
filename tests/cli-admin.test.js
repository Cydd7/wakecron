'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../lib/cli');
const { sudoersRule, sudoersFileName } = require('../lib/sudoers');
const { syncAgentObject } = require('../lib/agents');
const { toPlistXml } = require('../lib/plist');
const { makeSandbox } = require('./helpers');

const S = '#!/bin/sh\necho hi\n';
const USER = os.userInfo().username;

test('sync rebuilds agents from this folder and Node, and removes orphans', () => {
  const sb = makeSandbox(); sb.writeScript('hello.sh', S); sb.runCli(['setup']); sb.runCli(['add', 'hello.sh', '07:30']);
  const file = path.join(sb.root, 'jobs', 'hello-0730.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), node: '/old/node', root: '/old/root' }));
  fs.rmSync(sb.agentFile('local.wakecron.hello-0730')); sb.unload('local.wakecron.hello-0730');
  fs.writeFileSync(sb.agentFile('local.wakecron.ghost-0700'), ''); sb.markLoaded('local.wakecron.ghost-0700');
  const syncLoads = () => sb.calls('launchctl').filter((c) => c.args[0] === 'bootstrap' && c.args[2].endsWith('local.wakecron.sync.plist')).length;
  const loadsBefore = syncLoads();
  const r = sb.runCli(['sync']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Synced 1 job\(s\), removed 1 orphaned agent\(s\), 1 wake-up\(s\) scheduled\.$/m);
  const job = sb.readJob('hello-0730'); assert.equal(job.node, process.execPath); assert.equal(job.root, sb.root);
  assert.match(fs.readFileSync(sb.agentFile('local.wakecron.hello-0730'), 'utf8'), new RegExp(`${sb.root}/wakecron`));
  assert.deepEqual(sb.loaded(), ['local.wakecron.hello-0730', 'local.wakecron.sync']);
  assert.equal(fs.existsSync(sb.agentFile('local.wakecron.ghost-0700')), false);
  assert.equal(syncLoads(), loadsBefore + 1); // the login agent was rewritten and reloaded
  assert.deepEqual(sb.calls('pmset').slice(-2).map((c) => c.args[1]), ['cancel', 'wake']);
});

test('sync --wakes-only only re-arms wake-ups', () => {
  const sb = makeSandbox(); sb.writeScript('hello.sh', S); sb.runCli(['add', 'hello.sh', '07:30']);
  const before = fs.readFileSync(sb.agentFile('local.wakecron.hello-0730'), 'utf8');
  const r = sb.runCli(['sync', '--wakes-only']);
  assert.equal(r.code, 0); assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(sb.agentFile('local.wakecron.hello-0730'), 'utf8'), before);
  assert.deepEqual(sb.calls('pmset').slice(-2).map((c) => c.args[1]), ['cancel', 'wake']);
});

test('setup installs the sudoers rule and the login agent', () => {
  const sb = makeSandbox();
  const r = sb.runCli(['setup']);
  assert.equal(r.code, 0, r.stderr);
  const [visudo] = sb.calls('visudo'); const [install] = sb.calls('install');
  assert.equal(visudo.args[0], '-cf'); assert.equal(visudo.content, sudoersRule({ user: USER })); assert.equal(visudo.viaSudo, true);
  assert.deepEqual(install.args, ['-m', '0440', '-o', 'root', '-g', 'wheel', visudo.args[1], `/etc/sudoers.d/${sudoersFileName(USER)}`]);
  assert.equal(install.content, sudoersRule({ user: USER })); assert.equal(fs.existsSync(visudo.args[1]), false);
  const ctx = sb.ctx(); // same root, home, env and node as the CLI child
  assert.equal(fs.readFileSync(sb.agentFile('local.wakecron.sync'), 'utf8'), toPlistXml(syncAgentObject(ctx)));
  assert.deepEqual(sb.loaded(), ['local.wakecron.sync']);
  assert.match(r.stdout, /✓ passwordless wake-ups enabled \(\/etc\/sudoers\.d\/wakecron_/);
  assert.match(r.stdout, /✓ login agent installed/); assert.match(r.stdout, /Setup complete\. Try: \.\/wakecron add hello\.sh \+3m/);
  assert.match(sb.runCli(['list']).stdout, /^✓ login agent$/m);
});

test('setup warns about privacy-protected folders', () => {
  const sb = makeSandbox({ rootInHome: 'Documents/wakecron' });
  assert.match(sb.runCli(['setup']).stderr, /is inside .*Documents\. macOS blocks background jobs from reading there — move this folder to ~\/wakecron\./);
});

test('setup stops when visudo rejects the rule', () => {
  const sb = makeSandbox();
  const r = sb.runCli(['setup'], { env: { FAKE_FAIL: 'visudo' } });
  assert.equal(r.code, 1); assert.match(r.stderr, /visudo/); assert.equal(sb.calls('install').length, 0);
});

test('setup refuses a user name sudoers cannot hold', async () => {
  const sb = makeSandbox(); const io = sb.io({ username: 'bad name' });
  assert.equal(await main(['setup'], io), 2);
  assert.match(io.stderr.text, /"bad name" can't be used in a sudoers rule/);
});

test('uninstall removes agents, wake-ups and the rule, keeping your files', () => {
  const sb = makeSandbox(); sb.writeScript('a.sh', S); sb.writeScript('b.sh', S);
  sb.runCli(['setup']); sb.runCli(['add', 'a.sh', '07:30']); sb.runCli(['add', 'b.sh', '18:00']);
  const r = sb.runCli(['uninstall']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sb.loaded(), []); assert.deepEqual(sb.wakes(), []);
  assert.deepEqual(fs.readdirSync(sb.ctx().paths.agentsDir).filter((f) => f.startsWith('local.wakecron.')), []);
  assert.deepEqual(sb.calls('rm').at(-1).args, ['-f', `/etc/sudoers.d/${sudoersFileName(USER)}`]);
  assert.notEqual(sb.readJob('a-0730'), null);
  assert.match(r.stdout, /^Cancelled 2 wake-up\(s\), removed 3 agent\(s\) and the sudoers rule\.$/m);
  assert.match(r.stdout, new RegExp(`still in ${sb.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Delete that folder`));
});
