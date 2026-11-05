'use strict';
// Keeps pmset's wake-ups in line with the jobs: one wake event per minute that any job needs
// next, tagged "wakecron". What wakecron believes it has scheduled lives in state/wakes.json,
// read and written only under a lock file so concurrent runs don't trample each other.
const fs = require('node:fs');
const { listJobs } = require('./jobs');
const { nextWake, formatPmsetDate, parsePmsetDate } = require('./schedule');
const { ensureDir, writeFileAtomic } = require('./util');
const macos = require('./macos');

const NO_SUDO_MESSAGE = "passwordless wake-ups aren't set up — run ./wakecron setup";
const PROMPT_NOTICE = 'Scheduling a wake-up needs admin rights (run ./wakecron setup to stop these prompts).';
const LOCK_BUSY_MESSAGE = 'another wakecron process is updating wake-ups — try again';

const isDate = (text) => typeof text === 'string' && !Number.isNaN(parsePmsetDate(text).getTime());
const chronological = (dates) => [...new Set(dates)].sort((a, b) => parsePmsetDate(a) - parsePmsetDate(b));

function readWakeState(ctx) {
  try {
    const data = JSON.parse(fs.readFileSync(ctx.paths.wakesFile, 'utf8'));
    return Array.isArray(data.scheduled) ? data.scheduled.filter(isDate) : [];
  } catch {
    return [];
  }
}

function writeWakeState(ctx, dates) {
  writeFileAtomic(ctx.paths.wakesFile, `${JSON.stringify({ scheduled: chronological(dates) }, null, 2)}\n`);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A lock is stale when it is older than staleMs or its process is gone. An empty or unreadable
// lock is still being written by its owner, so it only goes stale with age.
function lockIsStale(file, staleMs) {
  let stat;
  let pid;
  try {
    stat = fs.statSync(file);
    pid = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return false; // gone already: the next attempt will take it
  }
  if (Date.now() - stat.mtimeMs > staleMs) return true;
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

function withLock(ctx, fn, { timeoutMs = 15000, staleMs = 600000 } = {}) {
  const file = ctx.paths.wakesLock;
  ensureDir(ctx.paths.stateDir);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(file, staleMs)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(LOCK_BUSY_MESSAGE);
      sleepSync(100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function desiredWakes(jobs, now) {
  const dates = [];
  for (const job of jobs) {
    try {
      const wake = nextWake(job.schedule, now);
      if (wake) dates.push(formatPmsetDate(wake));
    } catch {
      // a hand-edited schedule wakecron can't read: no wake-up for it
    }
  }
  return chronological(dates);
}

function pmsetMode(ctx) {
  if (macos.canSudoPmset(ctx)) return 'nopasswd';
  return ctx.interactive ? 'prompt' : null;
}

function reconcileWakes(ctx, { force = false } = {}) {
  return withLock(ctx, () => {
    const now = ctx.now();
    const result = { scheduled: [], cancelled: [], errors: [] };
    const desired = desiredWakes(listJobs(ctx).jobs, now);
    const prev = readWakeState(ctx).filter((d) => parsePmsetDate(d).getTime() > now.getTime());
    const stale = prev.filter((d) => !desired.includes(d));
    const missing = force ? desired : desired.filter((d) => !prev.includes(d));
    if (stale.length === 0 && missing.length === 0) {
      writeWakeState(ctx, prev);
      return result;
    }
    const mode = pmsetMode(ctx);
    if (!mode) {
      result.errors.push(NO_SUDO_MESSAGE);
      writeWakeState(ctx, prev);
      return result;
    }
    const prompt = mode === 'prompt';
    if (prompt) ctx.warn(PROMPT_NOTICE);
    const believed = new Set(force ? [] : prev.filter((d) => desired.includes(d)));
    for (const date of stale) {
      macos.pmsetWake(ctx, date, { cancel: true, prompt }); // already gone is fine
      result.cancelled.push(date);
    }
    if (force) for (const date of desired) macos.pmsetWake(ctx, date, { cancel: true, prompt }); // so exactly one remains
    for (const date of missing) {
      const r = macos.pmsetWake(ctx, date, { prompt });
      if (r.code === 0) {
        believed.add(date);
        result.scheduled.push(date);
      } else {
        result.errors.push(macos.failure('pmset', ['schedule', 'wake', date], r).message);
      }
    }
    writeWakeState(ctx, [...believed]);
    return result;
  });
}

function cancelAllWakes(ctx) {
  return withLock(ctx, () => {
    const result = { cancelled: [], errors: [] };
    const dates = readWakeState(ctx);
    if (dates.length === 0) return result;
    const mode = pmsetMode(ctx);
    if (!mode) {
      result.errors.push(NO_SUDO_MESSAGE);
      return result;
    }
    const prompt = mode === 'prompt';
    if (prompt) ctx.warn(PROMPT_NOTICE);
    for (const date of dates) {
      macos.pmsetWake(ctx, date, { cancel: true, prompt });
      result.cancelled.push(date);
    }
    writeWakeState(ctx, []);
    return result;
  });
}

module.exports = {
  NO_SUDO_MESSAGE, PROMPT_NOTICE, LOCK_BUSY_MESSAGE,
  readWakeState, writeWakeState, withLock, desiredWakes, pmsetMode, reconcileWakes, cancelAllWakes,
};
