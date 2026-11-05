'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runJob, readLastRun } = require('../lib/runner');
const macos = require('../lib/macos');
const { writeJob, readJob, deleteJob } = require('../lib/jobs');
const { installAgent, jobAgentObject, captureEnv } = require('../lib/agents');
const { jobLabel, logFile } = require('../lib/paths');
const { ALL_DAYS } = require('../lib/schedule');
const { makeSandbox } = require('./helpers');

const NOW = new Date(2026, 10, 5, 7, 30, 0, 300); // Thu 05 Nov 2026 07:30:00.300
function prepare(t, { script = 's.sh', content = '#!/bin/sh\necho out\n', mode = 0o755, schedule = { type: 'repeat', hour: 7, minute: 30, days: ALL_DAYS }, env = {} } = {}) {
  const sb = makeSandbox();
  sb.writeScript(script, content, mode);
  const ctx = sb.ctx({ now: () => NOW, env: { ...sb.env, ...env } });
  const job = { id: 's-0730', script, schedule, node: process.execPath, root: sb.root, env: captureEnv(sb.env), createdAt: NOW.toISOString() };
  writeJob(ctx, job); installAgent(ctx, jobLabel(job.id), jobAgentObject(job));
  const caf = t.mock.method(macos, 'startCaffeinate', () => ({ kill() { caf.killed = true; } }));
  return { sb, ctx, caf, log: () => fs.readFileSync(logFile(ctx, 's-0730'), 'utf8'), last: () => readLastRun(ctx, 's-0730'),
    notes: () => sb.calls('osascript').map((c) => c.args.at(-1)) };
}

test('a manual run logs and echoes output and returns the exit code', async (t) => {
  const { ctx, caf, log, last, notes } = prepare(t, { content: '#!/bin/sh\necho out\necho err >&2\nexit 3\n' });
  assert.equal(await runJob(ctx, 's-0730'), 3);
  assert.match(log(), /^=== 2026-11-05 07:30:00 start s\.sh \(manual\) ===\n/);
  assert.match(log(), /\nout\n/); assert.match(log(), /\nerr\n/);
  assert.match(log(), /\n=== 2026-11-05 07:30:00 exit 3 after \d+\.\ds ===\n$/);
  assert.match(ctx.stdout.text, /out/);
  assert.match(ctx.stderr.text, /\[wakecron\] exit 3 — log: logs\/s-0730\.log/);
  const { startedAt, finishedAt, durationMs, ...rest } = last();
  assert.deepEqual(rest, { exitCode: 3, signal: null, scheduled: false, error: null });
  assert.equal(typeof caf.mock.calls[0].arguments[1], 'number'); assert.equal(caf.killed, true);
  assert.deepEqual(notes(), []);
});

test('a failed scheduled run notifies', async (t) => {
  const { ctx, notes } = prepare(t, { content: '#!/bin/sh\nexit 3\n' });
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 3);
  assert.deepEqual(notes(), ['s.sh failed (exit 3)']);
});

test('a scheduled run re-arms the next wake first', async (t) => {
  const { sb, ctx, log } = prepare(t);
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 0);
  assert.deepEqual(sb.wakes(), ['11/06/26 07:29:00|wakecron']);
  assert.doesNotMatch(log(), /warning/);
});

test('a wake-up that cannot be armed is a warning, not a failure', async (t) => {
  const { ctx, log } = prepare(t, { env: { FAKE_SUDO: 'deny' } });
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 0);
  assert.match(log(), /\[wakecron\] warning: passwordless wake-ups aren't set up — run \.\/wakecron setup\n/);
  assert.match(log(), /\nout\n/);
});

test('scripts without #! run with bash', async (t) => {
  const { ctx, log } = prepare(t, { content: 'echo "bash:$BASH_VERSION"\n', mode: 0o644 });
  assert.equal(await runJob(ctx, 's-0730'), 0);
  assert.match(log(), /bash:\d/);
});

test('#! scripts that are not executable are fixed', async (t) => {
  const { ctx, log } = prepare(t, { mode: 0o644 });
  assert.equal(await runJob(ctx, 's-0730'), 0);
  assert.match(log(), /\[wakecron\] note: made scripts\/s\.sh executable\n/);
});

test('a missing script fails clearly', async (t) => {
  const { sb, ctx, log, last, notes } = prepare(t);
  fs.rmSync(`${sb.root}/scripts/s.sh`);
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 1);
  assert.match(log(), /=== 2026-11-05 07:30:00 failed: script not found ===\n$/);
  assert.equal(last().error, 'script not found');
  assert.deepEqual(notes(), ['s.sh failed (script not found)']);
});

test('a one-time run removes its job and unloads itself', async (t) => {
  const { sb, ctx, log } = prepare(t, { schedule: { type: 'once', at: '2026-11-05T07:30' } });
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 0);
  assert.match(log(), /\nout\n/);
  assert.equal(readJob(ctx, 's-0730'), null);
  assert.equal(fs.existsSync(sb.agentFile('local.wakecron.s-0730')), false);
  await sb.waitFor(() => !sb.loaded().includes('local.wakecron.s-0730'));
});

test('a one-time job fired early (next year) is left alone', async (t) => {
  const { ctx, log } = prepare(t, { schedule: { type: 'once', at: '2027-11-05T07:30' } });
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 0);
  assert.match(log(), /\[wakecron\] 2026-11-05 07:30:00 not due until 2027-11-05 07:30:00; skipped/);
  assert.doesNotMatch(log(), /\nout\n/); assert.notEqual(readJob(ctx, 's-0730'), null);
});

test('a one-time job more than 24 h late is skipped and removed', async (t) => {
  const { ctx, log, notes } = prepare(t, { schedule: { type: 'once', at: '2026-11-03T07:30' } });
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 0);
  assert.match(log(), /skipped: missed by more than 24 h \(was due 2026-11-03 07:30:00\)/);
  assert.doesNotMatch(log(), /\nout\n/);
  assert.deepEqual(notes(), ['s.sh skipped: missed by more than 24 h']);
  assert.equal(readJob(ctx, 's-0730'), null);
});

test('an orphaned agent removes itself', async (t) => {
  const { sb, ctx } = prepare(t);
  deleteJob(ctx, 's-0730');
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 0);
  assert.match(fs.readFileSync(ctx.paths.launchdLog, 'utf8'), /removed orphaned agent local\.wakecron\.s-0730 \(no job file\)/);
  assert.equal(fs.existsSync(sb.agentFile('local.wakecron.s-0730')), false);
  await sb.waitFor(() => !sb.loaded().includes('local.wakecron.s-0730'));
});

test('the log rotates past 1 MiB', async (t) => {
  const { ctx, log } = prepare(t);
  fs.mkdirSync(ctx.paths.logsDir, { recursive: true });
  fs.writeFileSync(logFile(ctx, 's-0730'), Buffer.alloc(1048577, 'x'));
  await runJob(ctx, 's-0730');
  assert.equal(fs.statSync(`${logFile(ctx, 's-0730')}.1`).size, 1048577);
  assert.match(log(), /^=== /);
});

test('review focus: output without a trailing newline', async (t) => {
  const { ctx, log } = prepare(t, { content: "#!/bin/sh\nprintf 'no newline'\n" });
  await runJob(ctx, 's-0730');
  assert.match(log(), /no newline\n=== 2026-11-05 07:30:00 exit 0 after/);
});

test('review focus: a script killed by a signal', async (t) => {
  const { ctx, caf, log, last, notes } = prepare(t, { content: '#!/bin/sh\nkill -TERM $$\n' });
  assert.equal(await runJob(ctx, 's-0730', { scheduled: true }), 1);
  assert.match(log(), /=== 2026-11-05 07:30:00 killed by SIGTERM after \d+\.\ds ===\n$/);
  assert.equal(last().signal, 'SIGTERM'); assert.equal(last().exitCode, null);
  assert.deepEqual(notes(), ['s.sh failed (killed by SIGTERM)']);
  assert.equal(caf.killed, true);
});
