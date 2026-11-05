'use strict';
// Runs one job: write the log, keep the Mac awake while the script runs, record the result,
// notify on failure, and — for scheduled runs — re-arm the next wake-up and clean up one-time jobs.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { UsageError, ensureDir, writeFileAtomic } = require('./util');
const { jobLabel, agentPlistPath, logFile, lastRunFile } = require('./paths');
const { readJob, deleteJob, resolveScript, scriptInfo, ensureExecutable } = require('./jobs');
const { onceDate, formatStamp } = require('./schedule');
const { reconcileWakes } = require('./wake');
const macos = require('./macos'); // called as macos.x() so tests can stub single functions

const MAX_LOG_BYTES = 1048576;
const EARLY_MS = 2 * 60 * 1000;
const LATE_MS = 24 * 60 * 60 * 1000;
const TITLE = 'wakecron';

function readLastRun(ctx, id) {
  try {
    return JSON.parse(fs.readFileSync(lastRunFile(ctx, id), 'utf8'));
  } catch {
    return null;
  }
}

function rotateLog(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

// Appends to a log file and remembers whether it ends with a newline, so wakecron's own lines
// always start on a fresh line even after output like `printf 'no newline'`.
function openLog(file) {
  ensureDir(path.dirname(file));
  let atLineStart = true;
  try {
    const { size } = fs.statSync(file);
    if (size > 0) {
      const last = Buffer.alloc(1);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, last, 0, 1, size - 1);
      } finally {
        fs.closeSync(fd);
      }
      atLineStart = last[0] === 0x0a;
    }
  } catch {
    // new file
  }
  const write = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (buf.length === 0) return;
    fs.appendFileSync(file, buf);
    atLineStart = buf[buf.length - 1] === 0x0a;
  };
  return { write, line: (text) => write(`${atLineStart ? '' : '\n'}${text}\n`) };
}

function appendLaunchdLog(ctx, text) {
  ensureDir(ctx.paths.logsDir);
  fs.appendFileSync(ctx.paths.launchdLog, `${text}\n`);
}

function executeScript(ctx, job, { scheduled, echo, log }) {
  const started = ctx.now();
  const t0 = Date.now();
  const stamp = () => formatStamp(ctx.now());
  log.line(`=== ${formatStamp(started)} start ${job.script} (${scheduled ? 'scheduled' : 'manual'}) ===`);

  const finish = (fields, endLine) => {
    const durationMs = Date.now() - t0;
    log.line(endLine((durationMs / 1000).toFixed(1)));
    const record = {
      startedAt: started.toISOString(), finishedAt: ctx.now().toISOString(),
      exitCode: null, signal: null, durationMs, scheduled, error: null, ...fields,
    };
    writeFileAtomic(lastRunFile(ctx, job.id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  };
  const failed = (error) => finish({ error }, () => `=== ${stamp()} failed: ${error} ===`);

  let abs;
  try {
    ({ abs } = resolveScript(ctx, job.script));
  } catch (e) {
    return Promise.resolve(failed(e.message.startsWith('no script') ? 'script not found' : e.message));
  }
  const info = scriptInfo(abs);
  if (info.hasShebang && !info.executable && ensureExecutable(abs)) log.line(`[wakecron] note: made scripts/${job.script} executable`);
  const [command, args] = info.hasShebang ? [abs, []] : [ctx.tools.bash, [abs]];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: ctx.paths.scriptsDir, env: { ...ctx.env, WAKECRON_JOB_ID: job.id }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve(failed(e.message));
      return;
    }
    const awake = child.pid ? macos.startCaffeinate(ctx, child.pid) : null;
    let settled = false;
    const settle = (record) => {
      if (settled) return;
      settled = true;
      if (awake) awake.kill();
      resolve(record);
    };
    child.stdout.on('data', (chunk) => {
      log.write(chunk);
      if (echo) ctx.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      log.write(chunk);
      if (echo) ctx.stderr.write(chunk);
    });
    child.on('error', (e) => settle(failed(e.message)));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (signal) settle(finish({ signal }, (secs) => `=== ${stamp()} killed by ${signal} after ${secs}s ===`));
      else settle(finish({ exitCode: code }, (secs) => `=== ${stamp()} exit ${code} after ${secs}s ===`));
    });
  });
}

// Re-arm wake-ups; problems become warnings in the job log rather than failing the run.
function rearm(ctx, log) {
  try {
    for (const error of reconcileWakes(ctx).errors) log.line(`[wakecron] warning: ${error}`);
  } catch (e) {
    log.line(`[wakecron] warning: ${e.message}`);
  }
}

// Removing our own agent with a synchronous bootout would make launchd stop this very process,
// so delete the plist and unload from a detached process instead.
function unloadSelf(ctx, label) {
  fs.rmSync(agentPlistPath(ctx, label), { force: true });
  macos.bootoutDetached(ctx, label);
}

function cleanUpOnce(ctx, job, log) {
  deleteJob(ctx, job.id);
  fs.rmSync(agentPlistPath(ctx, jobLabel(job.id)), { force: true });
  rearm(ctx, log);
  macos.bootoutDetached(ctx, jobLabel(job.id));
}

async function runJob(ctx, id, { scheduled = false } = {}) {
  let job;
  try {
    job = readJob(ctx, id);
  } catch (e) {
    if (!scheduled) throw e;
    appendLaunchdLog(ctx, `[wakecron] ${formatStamp(ctx.now())} ${e.message}`);
    return 1;
  }
  if (!job) {
    if (!scheduled) throw new UsageError(`no job "${id}"`);
    appendLaunchdLog(ctx, `[wakecron] ${formatStamp(ctx.now())} removed orphaned agent ${jobLabel(id)} (no job file)`);
    unloadSelf(ctx, jobLabel(id));
    return 0;
  }

  const file = logFile(ctx, id);
  rotateLog(file);
  const log = openLog(file);

  if (!scheduled) {
    const record = await executeScript(ctx, job, { scheduled: false, echo: true, log });
    const code = record.exitCode ?? 1;
    ctx.warn(`[wakecron] exit ${code} — log: ${path.relative(ctx.root, file)}`);
    return code;
  }

  const quiet = { ...ctx, interactive: false }; // launchd runs have no one to type a password
  if (job.schedule.type === 'once') {
    const now = ctx.now();
    const at = onceDate(job.schedule);
    if (now.getTime() < at.getTime() - EARLY_MS) {
      log.line(`[wakecron] ${formatStamp(now)} not due until ${formatStamp(at)}; skipped`);
      return 0;
    }
    if (now.getTime() > at.getTime() + LATE_MS) {
      log.line(`[wakecron] ${formatStamp(now)} skipped: missed by more than 24 h (was due ${formatStamp(at)})`);
      macos.notify(ctx, TITLE, `${job.script} skipped: missed by more than 24 h`);
      cleanUpOnce(quiet, job, log);
      return 0;
    }
  }

  rearm(quiet, log);
  const record = await executeScript(ctx, job, { scheduled: true, echo: false, log });
  let reason = null;
  if (record.error) reason = record.error;
  else if (record.signal) reason = `killed by ${record.signal}`;
  else if (record.exitCode !== 0) reason = `exit ${record.exitCode}`;
  if (reason) macos.notify(ctx, TITLE, `${job.script} failed (${reason})`);
  if (job.schedule.type === 'once') cleanUpOnce(quiet, job, log);
  return record.exitCode ?? 1;
}

module.exports = { MAX_LOG_BYTES, runJob, readLastRun };
