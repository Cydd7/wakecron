'use strict';
// The command-line interface: turns `wakecron <command> ...` into calls on the other modules.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createContext, jobLabel, SYNC_LABEL } = require('./paths');
const { UsageError } = require('./util');
const schedule = require('./schedule');
const jobs = require('./jobs');
const agents = require('./agents');
const wake = require('./wake');
const runner = require('./runner');
const macos = require('./macos');

const USAGE = `wakecron — wake your Mac and run scripts on a schedule

Usage:
  ./wakecron setup                          one-time setup (asks for your password)
  ./wakecron add [script] [time] [-d days]  schedule a script from scripts/
  ./wakecron list                           jobs, next runs and wake-ups (the default)
  ./wakecron run <id>                       run a job now
  ./wakecron remove <id>                    delete a job (alias: rm)
  ./wakecron sync                           repair agents and wake-ups
  ./wakecron uninstall                      remove everything wakecron installed

Times:  07:30  7:30pm  7pm     every day, or on the days you pick
        2026-11-06 18:00       once
        +10m  +2h              once, that long from now
Days:   daily  weekdays  weekends  mon-fri  mon,wed,fri`;

function parse(args, options = {}) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
}

function requireId(id, usage) {
  if (!id) throw new UsageError(usage);
  if (!jobs.isValidId(id)) throw new UsageError(`"${id}" is not a valid job id`);
  return id;
}

// Wake-up problems never undo a command; they come back as messages to show.
function reconcile(ctx, options) {
  try {
    return wake.reconcileWakes(ctx, options).errors;
  } catch (e) {
    return [e.message];
  }
}

async function cmdAdd(ctx, args) {
  const { values, positionals } = parse(args, { days: { type: 'string', short: 'd' } });
  const [script, ...whenWords] = positionals;
  const whenText = whenWords.join(' ');
  const daysText = values.days;
  if (!script || !whenText) throw new UsageError('usage: wakecron add <script> <time> [--days D]');

  const now = ctx.now();
  const { rel, abs } = jobs.resolveScript(ctx, script);
  const sched = schedule.applyDays(schedule.parseWhen(whenText, now), daysText);
  const { jobs: existing, invalid } = jobs.listJobs(ctx);
  const duplicate = existing.find((j) => j.script === rel && jobs.sameSchedule(j.schedule, sched));
  if (duplicate) throw new UsageError(`${rel} is already scheduled for ${schedule.describeSchedule(sched)} (job ${duplicate.id})`);

  const info = jobs.scriptInfo(abs);
  if (info.hasShebang && !info.executable && jobs.ensureExecutable(abs)) ctx.out(`Made scripts/${rel} executable.`);
  if (!info.hasShebang) ctx.out(`Note: scripts/${rel} has no #! line, so it will run with /bin/bash.`);

  const taken = new Set([...existing.map((j) => j.id), ...invalid.map((i) => path.basename(i.file, '.json'))]);
  const id = jobs.makeJobId(rel, sched, taken);
  const job = { id, script: rel, schedule: sched, node: ctx.nodePath, root: ctx.root, env: agents.captureEnv(ctx.env), createdAt: now.toISOString() };
  jobs.writeJob(ctx, job);
  try {
    agents.installAgent(ctx, jobLabel(id), agents.jobAgentObject(job));
  } catch (e) {
    jobs.deleteJob(ctx, id);
    agents.removeAgent(ctx, jobLabel(id));
    throw e;
  }
  const errors = reconcile(ctx);

  ctx.out(`Added ${id}: ${rel} ${schedule.describeSchedule(sched)}`);
  const next = schedule.nextRun(sched, ctx.now());
  const wakeAt = schedule.nextWake(sched, ctx.now());
  if (next) ctx.out(`Next run: ${schedule.formatShort(next)}${wakeAt ? ` · Mac wakes ${schedule.formatShort(wakeAt)}` : ''}`);
  for (const error of errors) ctx.warn(`Warning: the Mac won't wake for this job: ${error}`);
  if (!macos.canSudoPmset(ctx)) ctx.out("Tip: run ./wakecron setup once so wake-ups don't need your password.");
  return 0;
}

function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function nextRunText(job, now) {
  return safely(() => {
    const next = schedule.nextRun(job.schedule, now);
    if (next) return schedule.formatShort(next);
    return job.schedule.type === 'once' ? 'missed' : '-';
  }, '-');
}

function lastRunText(ctx, id) {
  const last = runner.readLastRun(ctx, id);
  if (!last) return 'never';
  const finished = new Date(last.finishedAt);
  const when = Number.isNaN(finished.getTime()) ? '?' : schedule.formatShort(finished);
  if (last.exitCode === 0) return `✓ ${when}`;
  const reason = last.error || last.signal || `exit ${last.exitCode}`;
  return `✗ ${when} (${reason})`;
}

function printTable(ctx, rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  for (const row of rows) ctx.out(row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]))).join('  '));
}

function cmdList(ctx, args) {
  parse(args);
  const { jobs: all, invalid } = jobs.listJobs(ctx);
  const now = ctx.now();
  ctx.out(`wakecron — ${ctx.root}`);
  ctx.out('');
  if (all.length === 0 && invalid.length === 0) {
    ctx.out('No jobs yet. Add one with: ./wakecron add <script> <time>');
  } else if (all.length > 0) {
    printTable(ctx, [
      ['ID', 'SCRIPT', 'SCHEDULE', 'NEXT RUN', 'LAST RUN'],
      ...all.map((job) => [job.id, job.script, safely(() => schedule.describeSchedule(job.schedule), '?'), nextRunText(job, now), lastRunText(ctx, job.id)]),
    ]);
  }

  const warnings = invalid.map(({ file, error }) => `! ${file}: invalid job file (${error})`);
  for (const job of all) {
    if (!macos.isLoaded(ctx, jobLabel(job.id))) warnings.push(`! ${job.id} isn't loaded in launchd — run ./wakecron sync`);
    if (!job.node || !fs.existsSync(job.node)) warnings.push(`! ${job.id}: ${job.node} no longer exists — run ./wakecron sync`);
    if (job.root !== ctx.root) warnings.push(`! ${job.id} was set up in ${job.root} — run ./wakecron sync`);
  }
  if (warnings.length > 0) {
    ctx.out('');
    for (const warning of warnings) ctx.out(warning);
  }

  ctx.out('');
  ctx.out('Wake-ups scheduled (pmset):');
  const lines = macos.pmsetSchedLines(ctx);
  if (lines.length === 0) ctx.out('  none');
  for (const line of lines) ctx.out(`  ${line}`);
  ctx.out('');
  ctx.out(macos.canSudoPmset(ctx) ? '✓ passwordless wake-ups' : '✗ passwordless wake-ups — run ./wakecron setup');
  ctx.out(macos.isLoaded(ctx, SYNC_LABEL) ? '✓ login agent' : '✗ login agent — run ./wakecron setup');
  return 0;
}

function cmdRun(ctx, args) {
  const { values, positionals } = parse(args, { scheduled: { type: 'boolean' } });
  const id = requireId(positionals[0], 'usage: wakecron run <id>');
  return runner.runJob(ctx, id, { scheduled: Boolean(values.scheduled) });
}

function cmdRemove(ctx, args) {
  const { positionals } = parse(args);
  const id = requireId(positionals[0], 'usage: wakecron remove <id>');
  if (!jobs.readJob(ctx, id)) throw new UsageError(`no job "${id}"`);
  agents.removeAgent(ctx, jobLabel(id));
  jobs.deleteJob(ctx, id);
  for (const error of reconcile(ctx)) ctx.warn(`Warning: ${error}`);
  ctx.out(`Removed ${id}. Its log is kept in logs/${id}.log.`);
  return 0;
}

const COMMANDS = { add: cmdAdd, list: cmdList, run: cmdRun, remove: cmdRemove, rm: cmdRemove };

async function main(argv, io = {}) {
  const ctx = createContext(io);
  const [command = 'list', ...rest] = argv;
  try {
    if (['help', '--help', '-h'].includes(command)) {
      ctx.out(USAGE);
      return 0;
    }
    if (process.platform !== 'darwin' && !ctx.env.WAKECRON_BIN_DIR) throw new Error('wakecron only runs on macOS');
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`unknown command "${command}" (see ./wakecron help)`);
    return await handler(ctx, rest);
  } catch (e) {
    ctx.warn(`wakecron: ${e.message}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

module.exports = { main, USAGE };
