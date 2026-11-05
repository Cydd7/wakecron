'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const macos = require('../lib/macos');
const { makeSandbox } = require('./helpers');

const D = '11/06/26 07:29:00';

test('run returns the exit code; a missing tool gives 127', () => {
  const ctx = makeSandbox().ctx();
  assert.equal(macos.run(ctx, 'launchctl', ['print', 'gui/0/nope']).code, 113);
  assert.equal(macos.run({ ...ctx, tools: { ...ctx.tools, pmset: '/nonexistent/pmset' } }, 'pmset', ['-g', 'sched']).code, 127);
});

test('bootstrap, isLoaded and bootout', () => {
  const sb = makeSandbox(); const ctx = sb.ctx();
  const file = path.join(sb.home, 'x.plist');
  fs.writeFileSync(file, '<plist><dict><key>Label</key><string>local.wakecron.x</string></dict></plist>');
  assert.equal(macos.bootstrap(ctx, file).code, 0);
  assert.equal(macos.isLoaded(ctx, 'local.wakecron.x'), true);
  assert.equal(macos.bootout(ctx, 'local.wakecron.x').code, 0);
  assert.equal(macos.isLoaded(ctx, 'local.wakecron.x'), false);
  assert.notEqual(macos.bootout(ctx, 'local.wakecron.x').code, 0);
});

test('pmsetWake runs pmset through sudo -n with the wakecron owner', () => {
  const sb = makeSandbox(); const ctx = sb.ctx();
  assert.equal(macos.pmsetWake(ctx, D).code, 0);
  assert.deepEqual(sb.calls('sudo')[0].args, ['-n', path.join(sb.bin, 'pmset'), 'schedule', 'wake', D, 'wakecron']);
  assert.equal(sb.calls('pmset')[0].viaSudo, true);
  assert.deepEqual(sb.wakes(), [`${D}|wakecron`]);
  macos.pmsetWake(ctx, D, { cancel: true });
  assert.deepEqual(sb.calls('pmset')[1].args, ['schedule', 'cancel', 'wake', D, 'wakecron']);
  assert.deepEqual(sb.wakes(), []);
});

test('pmsetSchedLines keeps only wakecron events', () => {
  const sb = makeSandbox(); sb.seedWakes([D, '11/07/26 08:00:00|other']);
  const lines = macos.pmsetSchedLines(sb.ctx());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /wake at 11\/06\/2026 07:29:00 by 'wakecron'/);
});

test('canSudoPmset follows the sudo rule and is cached', () => {
  const sb = makeSandbox(); const ctx = sb.ctx();
  assert.equal(macos.canSudoPmset(ctx), true);
  macos.canSudoPmset(ctx);
  assert.equal(sb.calls('sudo').length, 1);
  assert.deepEqual(sb.calls('sudo')[0].args, ['-n', '-k', '-l', path.join(sb.bin, 'pmset'), 'schedule', 'wake', '01/01/30 00:00:00', 'wakecron']);
  assert.equal(macos.canSudoPmset(sb.ctx({ env: { ...sb.env, FAKE_SUDO: 'deny' } })), false);
});

test('canSudoPmset is not fooled by credentials cached from a recent sudo', () => {
  const sb = makeSandbox();
  assert.equal(macos.canSudoPmset(sb.ctx({ env: { ...sb.env, FAKE_SUDO: 'cached' } })), false);
});

test('notify passes title and text as arguments, never as AppleScript', () => {
  const sb = makeSandbox();
  macos.notify(sb.ctx(), 'wakecron', 'x "quoted" failed');
  assert.deepEqual(sb.calls('osascript')[0].args, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run', 'wakecron', 'x "quoted" failed']);
});

test('startCaffeinate waits on the given pid; bootoutDetached unloads in the background', async () => {
  const sb = makeSandbox(); const ctx = sb.ctx();
  const child = spawn('sleep', ['0.5']);
  macos.startCaffeinate(ctx, child.pid);
  await sb.waitFor(() => sb.calls('caffeinate').length === 1);
  assert.deepEqual(sb.calls('caffeinate')[0].args, ['-i', '-s', '-w', String(child.pid)]);
  sb.markLoaded('local.wakecron.y');
  macos.bootoutDetached(ctx, 'local.wakecron.y');
  await sb.waitFor(() => !sb.loaded().includes('local.wakecron.y'));
});

test('failure() describes the command', () => {
  const e = macos.failure('launchctl', ['bootstrap', 'gui/501', '/x.plist'], { code: 5, stdout: '', stderr: 'Bootstrap failed: 5\n' });
  assert.equal(e.message, 'launchctl bootstrap gui/501 /x.plist exited 5: Bootstrap failed: 5');
});
