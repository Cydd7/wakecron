'use strict';
// Checks the generated rule against real sudo. Runs only as root on Linux (e.g. a CI container);
// everywhere else it reports as skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sudoersRule } = require('../lib/sudoers');

const NEEDED = ['/usr/bin/sudo', '/usr/sbin/visudo', '/usr/sbin/useradd', '/usr/sbin/userdel', '/usr/sbin/runuser', '/etc/sudoers.d'];
const canRun = process.platform === 'linux' && process.getuid() === 0 && NEEDED.every((p) => fs.existsSync(p));

test('real sudo allows only the two wake commands', { skip: canRun ? false : 'needs root, sudo and useradd on Linux' }, () => {
  const user = 'wcprobe';
  const dir = fs.mkdtempSync('/opt/wakecron-probe-');
  fs.chmodSync(dir, 0o755);
  const pmset = path.join(dir, 'pmset');
  fs.writeFileSync(pmset, '#!/bin/sh\necho "ran: $*"\n', { mode: 0o755 });
  const installed = '/etc/sudoers.d/wakecron_probe_test';
  spawnSync('/usr/sbin/useradd', ['-M', '-s', '/bin/sh', user]);
  try {
    const rule = path.join(dir, 'rule');
    fs.writeFileSync(rule, sudoersRule({ user, pmsetPath: pmset }));
    assert.equal(spawnSync('/usr/sbin/visudo', ['-cf', rule]).status, 0);
    fs.copyFileSync(rule, installed);
    fs.chmodSync(installed, 0o440);
    const asUser = (...args) => spawnSync('/usr/sbin/runuser', ['-u', user, '--', 'sudo', '-n', ...args]).status;
    const D = '11/06/26 07:29:00';
    assert.equal(asUser(pmset, 'schedule', 'wake', D, 'wakecron'), 0);
    assert.equal(asUser(pmset, 'schedule', 'cancel', 'wake', D, 'wakecron'), 0);
    assert.equal(asUser('-l', pmset, 'schedule', 'wake', '01/01/30 00:00:00', 'wakecron'), 0);
    assert.equal(asUser('-k', '-l', pmset, 'schedule', 'wake', '01/01/30 00:00:00', 'wakecron'), 0); // wakecron's probe
    for (const denied of [
      ['schedule', 'wake', D, 'wakecron', '-a'], ['schedule', 'wake', D, 'evil'], ['schedule', 'wake', D],
      ['schedule', 'shutdown', D, 'wakecron'], ['schedule', 'cancelall'], ['-a', 'sleep', '0'],
      ['repeat', 'wake', 'MTWRFSU', '07:29:00'], ['schedule', 'wake', 'ab/06/26 07:29:00', 'wakecron'],
    ]) assert.equal(asUser(pmset, ...denied), 1, denied.join(' '));
  } finally {
    fs.rmSync(installed, { force: true });
    spawnSync('/usr/sbin/userdel', [user]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
