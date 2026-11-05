'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const p = require('../lib/paths');

test('createContext derives every location from root and home', () => {
  const ctx = p.createContext({ root: '/r', home: '/h', env: {} });
  assert.deepEqual(ctx.paths, { root: '/r', entry: '/r/wakecron', scriptsDir: '/r/scripts', jobsDir: '/r/jobs', logsDir: '/r/logs',
    stateDir: '/r/state', wakesFile: '/r/state/wakes.json', wakesLock: '/r/state/wakes.lock', launchdLog: '/r/logs/launchd.log',
    agentsDir: '/h/Library/LaunchAgents' });
  assert.deepEqual(ctx.tools, p.TOOL_PATHS);
  assert.equal(p.jobLabel('a-0730'), 'local.wakecron.a-0730');
  assert.equal(p.agentPlistPath(ctx, 'local.wakecron.a-0730'), '/h/Library/LaunchAgents/local.wakecron.a-0730.plist');
  assert.equal(p.jobFile(ctx, 'a'), '/r/jobs/a.json');
  assert.equal(p.logFile(ctx, 'a'), '/r/logs/a.log');
  assert.equal(p.lastRunFile(ctx, 'a'), '/r/logs/a.last.json');
});

test('WAKECRON_BIN_DIR redirects every tool except bash', () => {
  const ctx = p.createContext({ root: '/r', home: '/h', env: { WAKECRON_BIN_DIR: '/fake' } });
  for (const [name, file] of Object.entries(ctx.tools)) assert.equal(file, name === 'bash' ? '/bin/bash' : `/fake/${name}`);
  assert.equal(p.createContext({ env: { WAKECRON_BIN_DIR: '' } }).tools.pmset, '/usr/bin/pmset');
});

test('defaults: project root, interactive follows the terminals', () => {
  const ctx = p.createContext({ stdin: { isTTY: true }, stdout: { isTTY: true } });
  assert.equal(ctx.root, path.resolve(__dirname, '..'));
  assert.equal(ctx.interactive, true);
  assert.equal(ctx.nodePath, process.execPath);
});
