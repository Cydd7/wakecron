'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../lib/cli');
const { makeSandbox } = require('./helpers');

const S = '#!/bin/sh\necho hi\n';
const twoScripts = () => { const sb = makeSandbox(); sb.writeScript('a.sh', S); sb.writeScript('b.sh', S); return sb; };

test('asks for the script, the time and the days', async () => {
  const sb = twoScripts(); const io = sb.io({ interactive: true, input: '2\n07:30\nweekdays\n' });
  assert.equal(await main(['add'], io), 0);
  assert.match(io.stdout.text, /Scripts in scripts\/:\n  1\) a\.sh\n  2\) b\.sh\n/);
  assert.match(io.stdout.text, /Added b-0730: b\.sh weekdays 07:30/);
});

test('explains invalid answers and asks again', async () => {
  const sb = twoScripts(); const io = sb.io({ interactive: true, input: '9\nb.sh\n25:00\n7pm\n\n' });
  assert.equal(await main(['add'], io), 0);
  assert.match(io.stdout.text, /  pick a number from 1 to 2 or a script name\n/);
  assert.match(io.stdout.text, /  "25:00" is not a valid time \(try 07:30, 7:30pm or 7pm\)\n/);
  assert.match(io.stdout.text, /Added b-1900: b\.sh daily 19:00/);
});

test('end of input cancels without changes', async () => {
  const sb = twoScripts(); const io = sb.io({ interactive: true, input: '1\n' });
  assert.equal(await main(['add'], io), 2);
  assert.match(io.stderr.text, /wakecron: cancelled/);
  const jobsDir = path.join(sb.root, 'jobs');
  assert.deepEqual(fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [], []);
});

test('parts already given are not asked again; one-time times skip the days question', async () => {
  const sb = twoScripts();
  let io = sb.io({ interactive: true, input: '07:30\n' });
  assert.equal(await main(['add', 'a.sh', '--days', 'mon'], io), 0);
  assert.doesNotMatch(io.stdout.text, /Script \(number or name\)|Days \[/);
  assert.match(io.stdout.text, /Added a-0730: a\.sh Mon 07:30/);
  io = sb.io({ interactive: true, input: '1\n+10m\n' });
  assert.equal(await main(['add'], io), 0);
  assert.doesNotMatch(io.stdout.text, /Days \[/);
});

test('an empty scripts folder is a usage error', async () => {
  const sb = makeSandbox(); const io = sb.io({ interactive: true, input: '' });
  assert.equal(await main(['add'], io), 2);
  assert.match(io.stderr.text, /No scripts in scripts\/ yet/);
});
