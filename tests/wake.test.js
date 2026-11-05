'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const w = require('../lib/wake');
const { writeJob } = require('../lib/jobs');
const { makeSandbox } = require('./helpers');

const NOW = new Date(2026, 10, 5, 14, 29, 40);
const daily = { type: 'repeat', hour: 7, minute: 30, days: [0, 1, 2, 3, 4, 5, 6] };
const job = (id, schedule) => ({ id, script: 'x.sh', schedule, node: '/n', root: '/r', env: {}, createdAt: '' });

test('desiredWakes merges jobs in the same minute and drops past one-time jobs', () => {
  const jobs = [job('a', daily), job('b', daily), job('c', { type: 'once', at: '2026-11-05T15:00' }), job('d', { type: 'once', at: '2026-11-05T09:00' })];
  assert.deepEqual(w.desiredWakes(jobs, NOW), ['11/05/26 14:59:00', '11/06/26 07:29:00']);
});

test('reconcile schedules missing wakes, cancels stale ones and keeps the rest', () => {
  const sb = makeSandbox(); const ctx = sb.ctx({ now: () => NOW });
  writeJob(ctx, job('a', daily)); writeJob(ctx, job('c', { type: 'once', at: '2026-11-05T15:00' }));
  w.writeWakeState(ctx, ['11/06/26 07:29:00', '11/07/26 09:00:00']); sb.seedWakes(['11/06/26 07:29:00', '11/07/26 09:00:00']);
  assert.deepEqual(w.reconcileWakes(ctx), { scheduled: ['11/05/26 14:59:00'], cancelled: ['11/07/26 09:00:00'], errors: [] });
  assert.deepEqual(sb.wakes(), ['11/05/26 14:59:00|wakecron', '11/06/26 07:29:00|wakecron']);
  assert.deepEqual(w.readWakeState(ctx), ['11/05/26 14:59:00', '11/06/26 07:29:00']);
});

test('force cancels and re-schedules every wanted wake', () => {
  const sb = makeSandbox(); const ctx = sb.ctx({ now: () => NOW });
  writeJob(ctx, job('a', daily)); w.writeWakeState(ctx, ['11/06/26 07:29:00']); sb.seedWakes(['11/06/26 07:29:00']);
  assert.deepEqual(w.reconcileWakes(ctx, { force: true }).scheduled, ['11/06/26 07:29:00']);
  assert.deepEqual(sb.calls('pmset').map((c) => c.args[1]), ['cancel', 'wake']);
  assert.deepEqual(sb.wakes(), ['11/06/26 07:29:00|wakecron']);
});

test('without passwordless sudo or a terminal it reports and changes nothing', () => {
  const sb = makeSandbox(); const ctx = sb.ctx({ now: () => NOW, env: { ...sb.env, FAKE_SUDO: 'deny' } });
  writeJob(ctx, job('a', daily));
  assert.deepEqual(w.reconcileWakes(ctx), { scheduled: [], cancelled: [], errors: [w.NO_SUDO_MESSAGE] });
  assert.equal(sb.calls('pmset').length, 0); assert.deepEqual(w.readWakeState(ctx), []);
});

test('nothing to do never calls sudo', () => {
  const sb = makeSandbox(); const ctx = sb.ctx({ now: () => NOW, env: { ...sb.env, FAKE_SUDO: 'deny' } });
  assert.deepEqual(w.reconcileWakes(ctx), { scheduled: [], cancelled: [], errors: [] });
  assert.equal(sb.calls('sudo').length, 0);
});

test('cancelAllWakes cancels every recorded wake and clears the state', () => {
  const sb = makeSandbox(); const ctx = sb.ctx({ now: () => NOW });
  w.writeWakeState(ctx, ['11/06/26 07:29:00', '11/07/26 07:29:00']); sb.seedWakes(['11/06/26 07:29:00', '11/07/26 07:29:00']);
  assert.deepEqual(w.cancelAllWakes(ctx), { cancelled: ['11/06/26 07:29:00', '11/07/26 07:29:00'], errors: [] });
  assert.deepEqual(sb.wakes(), []); assert.deepEqual(w.readWakeState(ctx), []);
});

test('withLock waits for a live lock, then gives up', () => {
  const ctx = makeSandbox().ctx();
  fs.mkdirSync(ctx.paths.stateDir, { recursive: true }); fs.writeFileSync(ctx.paths.wakesLock, String(process.pid));
  assert.throws(() => w.withLock(ctx, () => 1, { timeoutMs: 300 }), { message: w.LOCK_BUSY_MESSAGE });
});

test('withLock takes over stale locks and releases its own', () => {
  const ctx = makeSandbox().ctx();
  fs.mkdirSync(ctx.paths.stateDir, { recursive: true });
  fs.writeFileSync(ctx.paths.wakesLock, '2147483646'); // no such process
  assert.equal(w.withLock(ctx, () => 'ran'), 'ran');
  assert.equal(fs.existsSync(ctx.paths.wakesLock), false);
  fs.writeFileSync(ctx.paths.wakesLock, String(process.pid));
  const old = (Date.now() - 11 * 60 * 1000) / 1000; fs.utimesSync(ctx.paths.wakesLock, old, old);
  assert.equal(w.withLock(ctx, () => 'ran again'), 'ran again');
});
