'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const a = require('../lib/agents');
const { toPlistXml } = require('../lib/plist');
const { makeSandbox } = require('./helpers');

test('captureEnv puts the terminal PATH first, then the standard folders', () => {
  assert.deepEqual(a.captureEnv({ PATH: '/x/bin:/usr/bin', LANG: 'en_US.UTF-8' }),
    { PATH: '/x/bin:/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' });
  assert.deepEqual(a.captureEnv({}), { PATH: a.DEFAULT_PATH_DIRS.join(':') });
});

test('jobAgentObject', () => {
  const job = { id: 'hello-0730', script: 'hello.sh', schedule: { type: 'repeat', hour: 7, minute: 30, days: [1, 3] },
    node: '/n/node', root: '/r', env: { PATH: '/usr/bin' }, createdAt: 'x' };
  assert.deepEqual(a.jobAgentObject(job), {
    Label: 'local.wakecron.hello-0730',
    ProgramArguments: ['/n/node', '/r/wakecron', 'run', 'hello-0730', '--scheduled'],
    StartCalendarInterval: [{ Weekday: 1, Hour: 7, Minute: 30 }, { Weekday: 3, Hour: 7, Minute: 30 }],
    EnvironmentVariables: { PATH: '/usr/bin' },
    StandardOutPath: '/r/logs/launchd.log',
    StandardErrorPath: '/r/logs/launchd.log',
  });
});

test('syncAgentObject', () => {
  const sb = makeSandbox(); const ctx = sb.ctx({ nodePath: '/n/node', env: { ...sb.env, PATH: '/usr/bin' } });
  assert.deepEqual(a.syncAgentObject(ctx), {
    Label: 'local.wakecron.sync',
    ProgramArguments: ['/n/node', path.join(sb.root, 'wakecron'), 'sync', '--wakes-only'],
    RunAtLoad: true,
    EnvironmentVariables: a.captureEnv({ PATH: '/usr/bin', LANG: sb.env.LANG }),
    StandardOutPath: path.join(sb.root, 'logs', 'launchd.log'),
    StandardErrorPath: path.join(sb.root, 'logs', 'launchd.log'),
  });
});

test('stableNodePath prefers a PATH entry that is the same binary (Homebrew symlink)', () => {
  const sb = makeSandbox();
  const brewBin = path.join(sb.home, 'brew', 'bin');
  fs.mkdirSync(brewBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(brewBin, 'node'));
  const other = path.join(sb.home, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  const ctx = sb.ctx({ env: { ...sb.env, PATH: `${other}:${brewBin}:/usr/bin` } });
  assert.equal(a.stableNodePath(ctx), path.join(brewBin, 'node'));
  assert.equal(a.syncAgentObject(ctx).ProgramArguments[0], path.join(brewBin, 'node'));
  assert.equal(a.stableNodePath(sb.ctx({ env: { ...sb.env, PATH: other } })), process.execPath);
});

test('installAgent writes, loads and reloads; removeAgent is idempotent', () => {
  const sb = makeSandbox(); const ctx = sb.ctx();
  const obj = { Label: 'local.wakecron.t', ProgramArguments: ['/bin/true'] };
  a.installAgent(ctx, 'local.wakecron.t', obj);
  a.installAgent(ctx, 'local.wakecron.t', obj);
  assert.equal(fs.readFileSync(sb.agentFile('local.wakecron.t'), 'utf8'), toPlistXml(obj));
  assert.deepEqual(sb.loaded(), ['local.wakecron.t']);
  assert.ok(fs.existsSync(ctx.paths.logsDir));
  assert.deepEqual(sb.calls('launchctl').map((c) => c.args[0]), ['bootout', 'bootstrap', 'bootout', 'bootstrap']);
  a.removeAgent(ctx, 'local.wakecron.t'); a.removeAgent(ctx, 'local.wakecron.t');
  assert.deepEqual(sb.loaded(), []); assert.equal(fs.existsSync(sb.agentFile('local.wakecron.t')), false);
});

test('installAgent reports a refused bootstrap', () => {
  const sb = makeSandbox(); const ctx = sb.ctx({ env: { ...sb.env, FAKE_FAIL: 'launchctl:bootstrap' } });
  assert.throws(() => a.installAgent(ctx, 'local.wakecron.t', { Label: 'local.wakecron.t' }), /launchctl bootstrap .* exited 1: fake failure/);
});

test('listAgentLabels', () => {
  const sb = makeSandbox(); const dir = sb.ctx().paths.agentsDir;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['local.wakecron.a.plist', 'local.wakecron.sync.plist', 'com.other.plist', 'local.wakecron.b.txt']) fs.writeFileSync(path.join(dir, f), '');
  assert.deepEqual(a.listAgentLabels(sb.ctx()), ['local.wakecron.a', 'local.wakecron.sync']);
});
