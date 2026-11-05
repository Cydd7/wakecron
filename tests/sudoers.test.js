'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sudoersRule, validateUsername, sudoersFileName } = require('../lib/sudoers');
const { UsageError } = require('../lib/util');

const D = '[0-9][0-9]/[0-9][0-9]/[0-9][0-9] [0-9][0-9]\\:[0-9][0-9]\\:[0-9][0-9]';

test('the rule allows exactly the two wake commands', () => {
  assert.equal(sudoersRule({ user: 'sid' }), [
    '# wakecron: lets sid schedule and cancel wake-ups without a password.',
    '# Installed by "wakecron setup"; removed by "wakecron uninstall".',
    'sid ALL = (root) NOPASSWD: \\',
    `  /usr/bin/pmset schedule wake ${D} wakecron, \\`,
    `  /usr/bin/pmset schedule cancel wake ${D} wakecron`,
    '',
  ].join('\n'));
  assert.match(sudoersRule({ user: 'sid', pmsetPath: '/opt/p/pmset' }), /^  \/opt\/p\/pmset schedule wake /m);
});

test('user names', () => {
  for (const ok of ['sid', 'sid.lodha', 'a_b-c', '_svc', 'root']) validateUsername(ok);
  for (const bad of ['', '-x', '.x', 'a b', 'a,b', 'a:b', 'root\nALL']) assert.throws(() => validateUsername(bad), UsageError, JSON.stringify(bad));
  assert.equal(sudoersFileName('sid'), 'wakecron_sid');
  assert.equal(sudoersFileName('sid.lodha'), 'wakecron_sid_lodha');
});
