'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeSandbox } = require('./helpers');

const HELLO = '#!/bin/sh\necho hi from hello\n';
const withHello = (opts) => { const sb = makeSandbox(opts); sb.writeScript('hello.sh', HELLO); return sb; };
const SHORT = String.raw`\w{3} \d{2} \w{3} \d{2}:\d{2}`;

test('add schedules a daily job, loads its agent and arms a wake-up', () => {
  const sb = withHello();
  const r = sb.runCli(['add', 'hello.sh', '07:30']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Added hello-0730: hello\.sh daily 07:30$/m);
  assert.match(r.stdout, new RegExp(`^Next run: \\w{3} \\d{2} \\w{3} 07:30 · Mac wakes \\w{3} \\d{2} \\w{3} 07:29$`, 'm'));
  const job = sb.readJob('hello-0730');
  assert.deepEqual(job.schedule, { type: 'repeat', hour: 7, minute: 30, days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(job.root, sb.root); assert.equal(job.node, process.execPath);
  assert.deepEqual(sb.loaded(), ['local.wakecron.hello-0730']);
  assert.equal(sb.wakes().length, 1); assert.match(sb.wakes()[0], /^\d\d\/\d\d\/\d\d 07:29:00\|wakecron$/);
});

test('add: --days and one-time forms', () => {
  const sb = withHello();
  assert.match(sb.runCli(['add', 'hello.sh', '07:30', '--days', 'mon-fri']).stdout, /Added hello-0730: hello\.sh weekdays 07:30/);
  assert.equal(fs.readFileSync(sb.agentFile('local.wakecron.hello-0730'), 'utf8').match(/<key>Weekday<\/key>/g).length, 5);
  const r = sb.runCli(['add', 'hello.sh', '2099-01-10', '18:00']);
  assert.match(r.stdout, /Added hello-1800: hello\.sh once 2099-01-10 18:00/);
  assert.deepEqual(sb.readJob('hello-1800').schedule, { type: 'once', at: '2099-01-10T18:00' });
});

test('add rejects bad input with exit 2', () => {
  const sb = withHello();
  const cases = [
    [['add', 'nope.sh', '07:30'], /wakecron: no script "nope\.sh" in scripts\//],
    [['add', '../x.sh', '07:30'], /must be inside scripts\//],
    [['add', 'hello.sh', '25:00'], /"25:00" is not a valid time/],
    [['add', 'hello.sh', '2020-01-01 10:00'], /is in the past/],
    [['add', 'hello.sh', '+5m', '--days', 'mon'], /--days only works with a repeating time/],
    [['add', 'hello.sh'], /usage: wakecron add <script> <time> \[--days D\]/],
    [['add', 'hello.sh', '07:30', '--bogus'], /wakecron: /],
  ];
  for (const [args, msg] of cases) { const r = sb.runCli(args); assert.equal(r.code, 2, args.join(' ')); assert.match(r.stderr, msg); }
  sb.runCli(['add', 'hello.sh', '07:30']);
  const dup = sb.runCli(['add', 'hello.sh', '07:30']);
  assert.equal(dup.code, 2); assert.match(dup.stderr, /hello\.sh is already scheduled for daily 07:30 \(job hello-0730\)/);
});

test('add fixes or explains scripts that cannot run as they are', () => {
  const sb = makeSandbox();
  sb.writeScript('bang.sh', HELLO, 0o644); sb.writeScript('plain.sh', 'echo plain\n', 0o644);
  assert.match(sb.runCli(['add', 'bang.sh', '07:30']).stdout, /^Made scripts\/bang\.sh executable\.$/m);
  assert.ok(fs.statSync(path.join(sb.root, 'scripts', 'bang.sh')).mode & 0o100);
  assert.match(sb.runCli(['add', 'plain.sh', '07:30']).stdout, /^Note: scripts\/plain\.sh has no #! line, so it will run with \/bin\/bash\.$/m);
});

test('add without passwordless sudo keeps the job and explains', () => {
  const sb = withHello();
  const r = sb.runCli(['add', 'hello.sh', '07:30'], { env: { FAKE_SUDO: 'deny' } });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /Warning: the Mac won't wake for this job: passwordless wake-ups aren't set up/);
  assert.match(r.stdout, /Tip: run \.\/wakecron setup once/);
  assert.notEqual(sb.readJob('hello-0730'), null);
});

test('add rolls back when launchd refuses the agent', () => {
  const sb = withHello();
  const r = sb.runCli(['add', 'hello.sh', '07:30'], { env: { FAKE_FAIL: 'launchctl:bootstrap' } });
  assert.equal(r.code, 1); assert.match(r.stderr, /launchctl bootstrap/);
  assert.equal(sb.readJob('hello-0730'), null); assert.equal(fs.existsSync(sb.agentFile('local.wakecron.hello-0730')), false);
});

test('list shows jobs, last results, wake-ups and setup status', () => {
  const sb = withHello();
  assert.match(sb.runCli(['list']).stdout, /No jobs yet\. Add one with: \.\/wakecron add <script> <time>/);
  sb.runCli(['add', 'hello.sh', '07:30']);
  let out = sb.runCli([]).stdout; // list is the default
  assert.match(out, /^ID\s+SCRIPT\s+SCHEDULE\s+NEXT RUN\s+LAST RUN$/m);
  assert.match(out, new RegExp(`^hello-0730\\s+hello\\.sh\\s+daily 07:30\\s+${SHORT}\\s+never$`, 'm'));
  assert.match(out, /^  .*wake at \d\d\/\d\d\/\d{4} 07:29:00 by 'wakecron'$/m);
  assert.match(out, /^✓ passwordless wake-ups$/m); assert.match(out, /^✗ login agent — run \.\/wakecron setup$/m);
  sb.runCli(['run', 'hello-0730']);
  fs.writeFileSync(path.join(sb.root, 'jobs', 'bad.json'), '{oops');
  out = sb.runCli(['list']).stdout;
  assert.match(out, new RegExp(`✓ ${SHORT}$`, 'm'));
  assert.match(out, /^! jobs\/bad\.json: invalid job file/m);
});

test('list flags agents that need a sync', () => {
  const sb = withHello();
  sb.runCli(['add', 'hello.sh', '07:30']);
  sb.unload('local.wakecron.hello-0730');
  const file = path.join(sb.root, 'jobs', 'hello-0730.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), root: '/elsewhere', node: '/missing/node' }));
  const out = sb.runCli(['list']).stdout;
  assert.match(out, /^! hello-0730 isn't loaded in launchd — run \.\/wakecron sync$/m);
  assert.match(out, /^! hello-0730: \/missing\/node no longer exists — run \.\/wakecron sync$/m);
  assert.match(out, /^! hello-0730 was set up in \/elsewhere — run \.\/wakecron sync$/m);
});

test('run runs a job now and exits with its code', () => {
  const sb = makeSandbox(); sb.writeScript('fail.sh', '#!/bin/sh\necho trying\nexit 4\n');
  sb.runCli(['add', 'fail.sh', '07:30']);
  const r = sb.runCli(['run', 'fail-0730']);
  assert.equal(r.code, 4); assert.match(r.stdout, /trying/);
  assert.match(fs.readFileSync(path.join(sb.root, 'logs', 'fail-0730.log'), 'utf8'), /start fail\.sh \(manual\)[\s\S]*exit 4 after/);
});

test('remove deletes the job and its wake-up, but keeps a shared wake-up', () => {
  const sb = makeSandbox(); sb.writeScript('a.sh', HELLO); sb.writeScript('b.sh', HELLO);
  sb.runCli(['add', 'a.sh', '07:30']); sb.runCli(['add', 'b.sh', '07:30']);
  assert.equal(sb.wakes().length, 1);
  const r = sb.runCli(['remove', 'a-0730']);
  assert.equal(r.code, 0); assert.match(r.stdout, /^Removed a-0730\. Its log is kept in logs\/a-0730\.log\.$/m);
  assert.equal(sb.wakes().length, 1); assert.equal(sb.readJob('a-0730'), null);
  assert.equal(fs.existsSync(sb.agentFile('local.wakecron.a-0730')), false); assert.deepEqual(sb.loaded(), ['local.wakecron.b-0730']);
  assert.equal(sb.runCli(['rm', 'b-0730']).code, 0); assert.deepEqual(sb.wakes(), []);
});

test('help, unknown commands and bad ids', () => {
  const sb = makeSandbox();
  for (const h of ['help', '--help']) {
    const r = sb.runCli([h]); assert.equal(r.code, 0); assert.match(r.stdout, /Usage:/);
    for (const cmd of ['setup', 'add', 'list', 'run', 'remove', 'sync', 'uninstall']) assert.match(r.stdout, new RegExp(`wakecron ${cmd}`));
  }
  assert.match(sb.runCli(['frobnicate']).stderr, /unknown command "frobnicate"/);
  assert.equal(sb.runCli(['frobnicate']).code, 2);
  assert.match(sb.runCli(['run', '../x']).stderr, /"\.\.\/x" is not a valid job id/);
  const r = sb.runCli(['remove', 'nope-0730']); assert.equal(r.code, 2); assert.match(r.stderr, /no job "nope-0730"/);
});

test('refuses to run off macOS', { skip: process.platform === 'darwin' }, () => {
  const sb = makeSandbox();
  const r = sb.runCli(['list'], { env: { WAKECRON_BIN_DIR: '' } });
  assert.equal(r.code, 1); assert.match(r.stderr, /wakecron only runs on macOS/);
});

test('review focus: a script with spaces in a subfolder', () => {
  const sb = makeSandbox(); sb.writeScript('Daily Jobs/My Backup.sh', '#!/bin/sh\necho backed up\n');
  assert.match(sb.runCli(['add', 'Daily Jobs/My Backup.sh', '07:30']).stdout, /Added my-backup-0730: Daily Jobs\/My Backup\.sh daily 07:30/);
  const r = sb.runCli(['run', 'my-backup-0730']); assert.equal(r.code, 0); assert.match(r.stdout, /backed up/);
});

test('review focus: a project folder with spaces and &', () => {
  const sb = withHello({ rootName: 'My Tools & Scripts' });
  assert.equal(sb.runCli(['add', 'hello.sh', '07:30']).code, 0);
  assert.match(fs.readFileSync(sb.agentFile('local.wakecron.hello-0730'), 'utf8'), /My Tools &amp; Scripts\/wakecron<\/string>/);
  const r = sb.runCli(['run', 'hello-0730']); assert.equal(r.code, 0); assert.match(r.stdout, /hi from hello/);
});

test('review focus: a job due within the minute', () => {
  const sb = withHello();
  const r = sb.runCli(['add', 'hello.sh', '+1m']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Added hello-\d{4}: hello\.sh once \d{4}-\d\d-\d\d \d\d:\d\d$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /undefined|Invalid Date|NaN/);
});
