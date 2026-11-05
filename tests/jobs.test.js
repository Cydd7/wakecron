'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const j = require('../lib/jobs');
const { makeSandbox } = require('./helpers');

const rep = { type: 'repeat', hour: 7, minute: 30, days: [1] };
const job = (id, extra = {}) => ({ id, script: 'a.sh', schedule: rep, node: '/n', root: '/r', env: { PATH: '/usr/bin' }, createdAt: 'now', ...extra });

test('slugify', () => {
  assert.equal(j.slugify('backup.sh'), 'backup');
  assert.equal(j.slugify('Daily Jobs/My Backup!.sh'), 'my-backup');
  assert.equal(j.slugify('.sh'), 'sh');
  assert.equal(j.slugify('___.js'), 'job');
  assert.equal(j.slugify('a-very-long-script-name-that-keeps-going.sh'), 'a-very-long-script-name');
});

test('makeJobId adds HHMM and avoids collisions', () => {
  assert.equal(j.makeJobId('backup.sh', rep, new Set()), 'backup-0730');
  assert.equal(j.makeJobId('backup.sh', rep, new Set(['backup-0730'])), 'backup-0730-2');
  assert.equal(j.makeJobId('backup.sh', rep, new Set(['backup-0730', 'backup-0730-2'])), 'backup-0730-3');
  assert.equal(j.makeJobId('report.js', { type: 'once', at: '2026-11-06T18:05' }, new Set()), 'report-1805');
});

test('isValidId', () => {
  for (const ok of ['backup-0730', 'a', 'x'.repeat(41)]) assert.equal(j.isValidId(ok), true, ok);
  for (const bad of ['sync', '-x', 'A', '../x', 'a b', '', 'x'.repeat(42)]) assert.equal(j.isValidId(bad), false, bad);
});

test('resolveScript stays inside scripts/', () => {
  const sb = makeSandbox(); const ctx = sb.ctx();
  sb.writeScript('a.sh', '#!/bin/sh\n'); sb.writeScript('Daily Jobs/My Backup.sh', '#!/bin/sh\n');
  assert.deepEqual(j.resolveScript(ctx, 'a.sh'), { rel: 'a.sh', abs: path.join(ctx.paths.scriptsDir, 'a.sh') });
  assert.equal(j.resolveScript(ctx, 'Daily Jobs/My Backup.sh').rel, 'Daily Jobs/My Backup.sh');
  assert.throws(() => j.resolveScript(ctx, 'nope.sh'), { name: 'UsageError', message: 'no script "nope.sh" in scripts/' });
  for (const out of ['../x.sh', '/etc/passwd']) assert.throws(() => j.resolveScript(ctx, out), { message: `scripts must be inside scripts/ ("${out}")` });
  assert.throws(() => j.resolveScript(ctx, 'Daily Jobs'), { message: '"Daily Jobs" is not a file' });
});

test('listScripts is recursive, sorted and skips hidden files', () => {
  const sb = makeSandbox();
  for (const f of ['a.sh', 'Daily Jobs/My Backup.sh', '.hidden.sh', '.git/x']) sb.writeScript(f, '#!/bin/sh\n');
  assert.deepEqual(j.listScripts(sb.ctx()), ['Daily Jobs/My Backup.sh', 'a.sh']);
});

test('scriptInfo and ensureExecutable', () => {
  const sb = makeSandbox();
  const withBang = sb.writeScript('a.sh', '#!/bin/sh\necho\n', 0o644);
  assert.deepEqual(j.scriptInfo(withBang), { hasShebang: true, executable: false });
  assert.equal(j.ensureExecutable(withBang), true);
  assert.ok(fs.statSync(withBang).mode & 0o100);
  assert.equal(j.ensureExecutable(withBang), false);
  assert.equal(j.scriptInfo(sb.writeScript('b.sh', 'echo\n')).hasShebang, false);
});

test('job files round-trip atomically; invalid files are reported', () => {
  const sb = makeSandbox(); const ctx = sb.ctx();
  j.writeJob(ctx, job('a-0730'));
  assert.deepEqual(j.readJob(ctx, 'a-0730'), job('a-0730'));
  fs.writeFileSync(path.join(ctx.paths.jobsDir, 'bad.json'), '{oops');
  const { jobs, invalid } = j.listJobs(ctx);
  assert.deepEqual(jobs, [job('a-0730')]);
  assert.equal(invalid.length, 1); assert.equal(invalid[0].file, 'jobs/bad.json');
  assert.throws(() => j.readJob(ctx, 'bad'), /^Error: invalid job file jobs\/bad\.json/);
  assert.equal(j.readJob(ctx, 'missing'), null);
  assert.equal(j.deleteJob(ctx, 'a-0730'), true); assert.equal(j.deleteJob(ctx, 'a-0730'), false);
  assert.deepEqual(fs.readdirSync(ctx.paths.jobsDir).filter((f) => f.includes('.tmp')), []);
  assert.deepEqual(j.listJobs(makeSandbox().ctx()), { jobs: [], invalid: [] });
});

test('sameSchedule', () => {
  assert.equal(j.sameSchedule(rep, { ...rep, days: [1] }), true);
  assert.equal(j.sameSchedule(rep, { ...rep, days: [2] }), false);
  assert.equal(j.sameSchedule({ type: 'once', at: 'x' }, { type: 'once', at: 'x' }), true);
});
