'use strict';
// The command-line interface: turns `wakecron <command> ...` into calls on the other modules.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const { createContext, jobLabel, agentPlistPath, SYNC_LABEL, SUDOERS_DIR } = require('./paths');
const { UsageError, ensureDir } = require('./util');
const { sudoersRule, sudoersFileName } = require('./sudoers');
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

// Reads answers one line at a time from ctx.stdin. End of input rejects the pending question
// with "cancelled", so Ctrl-D leaves everything unchanged.
function makeAsker(ctx) {
  const rl = readline.createInterface({ input: ctx.stdin, terminal: false });
  const queue = [];
  let waiting = null;
  let closed = false;
  rl.on('line', (line) => {
    if (!waiting) return queue.push(line);
    const { resolve } = waiting;
    waiting = null;
    return resolve(line);
  });
  rl.on('close', () => {
    closed = true;
    if (!waiting) return;
    const { reject } = waiting;
    waiting = null;
    reject(new UsageError('cancelled'));
  });
  return {
    ask(prompt) {
      ctx.stdout.write(prompt);
      if (queue.length > 0) return Promise.resolve(queue.shift().trim());
      if (closed) return Promise.reject(new UsageError('cancelled'));
      return new Promise((resolve, reject) => {
        waiting = { resolve: (line) => resolve(line.trim()), reject };
      });
    },
    close: () => rl.close(),
  };
}

// Ask until `check` accepts the answer; usage errors are explained and the question repeats.
async function askUntilValid(ctx, asker, prompt, check) {
  for (;;) {
    const answer = await asker.ask(prompt);
    try {
      return check(answer);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      ctx.out(`  ${e.message}`);
    }
  }
}

async function promptForAdd(ctx, { script, whenText, daysText }) {
  const asker = makeAsker(ctx);
  try {
    if (!script) {
      const scripts = jobs.listScripts(ctx);
      if (scripts.length === 0) throw new UsageError('No scripts in scripts/ yet. Add one, then run ./wakecron add again.');
      ctx.out('Scripts in scripts/:');
      scripts.forEach((name, i) => ctx.out(`  ${i + 1}) ${name}`));
      script = await askUntilValid(ctx, asker, 'Script (number or name): ', (answer) => {
        if (!/^\d+$/.test(answer)) return jobs.resolveScript(ctx, answer).rel;
        const n = Number(answer);
        if (n >= 1 && n <= scripts.length) return scripts[n - 1];
        throw new UsageError(`pick a number from 1 to ${scripts.length} or a script name`);
      });
    }
    let partial = safely(() => schedule.parseWhen(whenText, ctx.now()), null);
    if (!whenText) {
      ctx.out('When? 07:30 = every day · 2026-11-06 18:00 = once · +10m = in 10 minutes');
      whenText = await askUntilValid(ctx, asker, 'Time: ', (answer) => {
        partial = schedule.parseWhen(answer, ctx.now());
        return answer;
      });
    }
    if (partial && partial.type === 'repeat' && daysText === undefined) {
      daysText = await askUntilValid(ctx, asker, 'Days [daily] (weekdays, weekends, mon-fri, mon,wed,fri): ', (answer) => {
        const days = answer || 'daily';
        schedule.parseDays(days);
        return days;
      });
    }
    return { script, whenText, daysText };
  } finally {
    asker.close();
  }
}

async function cmdAdd(ctx, args) {
  const { values, positionals } = parse(args, { days: { type: 'string', short: 'd' } });
  let [script, ...whenWords] = positionals;
  let whenText = whenWords.join(' ');
  let daysText = values.days;
  if (!script || !whenText) {
    if (!ctx.interactive) throw new UsageError('usage: wakecron add <script> <time> [--days D]');
    ({ script, whenText, daysText } = await promptForAdd(ctx, { script, whenText, daysText }));
  }

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
  const job = { id, script: rel, schedule: sched, node: agents.stableNodePath(ctx), root: ctx.root, env: agents.captureEnv(ctx.env), createdAt: now.toISOString() };
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

function ensureFolders(ctx) {
  for (const dir of [ctx.paths.scriptsDir, ctx.paths.jobsDir, ctx.paths.logsDir, ctx.paths.stateDir]) ensureDir(dir);
}

// Rebuild every agent from this folder and the current Node, drop agents with no job, then
// re-schedule all wake-ups from scratch.
function fullSync(ctx) {
  ensureFolders(ctx);
  const errors = [];
  const { jobs: all } = jobs.listJobs(ctx);
  const env = agents.captureEnv(ctx.env);
  const node = agents.stableNodePath(ctx);
  for (const job of all) {
    const updated = { ...job, node, root: ctx.root, env };
    try {
      jobs.writeJob(ctx, updated);
      agents.installAgent(ctx, jobLabel(job.id), agents.jobAgentObject(updated));
    } catch (e) {
      errors.push(e.message);
    }
  }
  const wanted = new Set(all.map((job) => jobLabel(job.id)));
  let removed = 0;
  for (const label of agents.listAgentLabels(ctx)) {
    if (label === SYNC_LABEL || wanted.has(label)) continue;
    agents.removeAgent(ctx, label);
    removed += 1;
  }
  if (fs.existsSync(agentPlistPath(ctx, SYNC_LABEL))) {
    try {
      agents.installAgent(ctx, SYNC_LABEL, agents.syncAgentObject(ctx));
    } catch (e) {
      errors.push(e.message);
    }
  }
  let scheduled = 0;
  try {
    const result = wake.reconcileWakes(ctx, { force: true });
    scheduled = result.scheduled.length;
    errors.push(...result.errors);
  } catch (e) {
    errors.push(e.message);
  }
  ctx.out(`Synced ${all.length} job(s), removed ${removed} orphaned agent(s), ${scheduled} wake-up(s) scheduled.`);
  for (const error of errors) ctx.warn(`Warning: ${error}`);
  return errors.length === 0;
}

function cmdSync(ctx, args) {
  const { values } = parse(args, { 'wakes-only': { type: 'boolean' } });
  if (!values['wakes-only']) return fullSync(ctx) ? 0 : 1;
  const errors = reconcile(ctx, { force: true }); // the login agent: never rewrites agents, never prompts
  for (const error of errors) ctx.warn(`Warning: ${error}`);
  return errors.length === 0 ? 0 : 1;
}

const PROTECTED_FOLDERS = ['Desktop', 'Documents', 'Downloads', path.join('Library', 'Mobile Documents')];

// Compare real paths: the project root is already resolved (Node loads modules by real path),
// while HOME or the folders in it may go through symlinks.
function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function cmdSetup(ctx, args) {
  parse(args);
  ensureFolders(ctx);
  const root = realPath(ctx.root);
  for (const name of PROTECTED_FOLDERS) {
    const dir = realPath(path.join(ctx.home, name));
    if (root === dir || root.startsWith(`${dir}${path.sep}`)) {
      ctx.warn(`Warning: ${ctx.root} is inside ${dir}. macOS blocks background jobs from reading there — move this folder to ~/wakecron.`);
    }
  }

  const rule = sudoersRule({ user: ctx.username }); // refuses user names sudoers can't hold
  const target = `${SUDOERS_DIR}/${sudoersFileName(ctx.username)}`;
  const tmp = path.join(ctx.paths.stateDir, `sudoers-${process.pid}.tmp`);
  ctx.out('Installing the sudoers rule (sudo may ask for your password)...');
  fs.writeFileSync(tmp, rule);
  try {
    const checkArgs = ['-cf', tmp];
    const check = macos.sudo(ctx, 'visudo', checkArgs, { prompt: ctx.interactive });
    if (check.code !== 0) throw macos.failure('visudo', checkArgs, check);
    const installArgs = ['-m', '0440', '-o', 'root', '-g', 'wheel', tmp, target];
    const installed = macos.sudo(ctx, 'install', installArgs, { prompt: ctx.interactive });
    if (installed.code !== 0) throw macos.failure('install', installArgs, installed);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  ctx.cache.sudoPmset = undefined;
  ctx.out(macos.canSudoPmset(ctx)
    ? `✓ passwordless wake-ups enabled (${target})`
    : "✗ sudo doesn't accept the rule yet — check that /etc/sudoers includes /private/etc/sudoers.d");

  agents.installAgent(ctx, SYNC_LABEL, agents.syncAgentObject(ctx));
  ctx.out('✓ login agent installed (re-arms wake-ups at login)');
  const ok = fullSync(ctx);
  ctx.out('Setup complete. Try: ./wakecron add hello.sh +3m');
  return ok ? 0 : 1;
}

function cmdUninstall(ctx, args) {
  parse(args);
  let cancelled = 0;
  try {
    const result = wake.cancelAllWakes(ctx);
    cancelled = result.cancelled.length;
    for (const error of result.errors) ctx.warn(`Warning: ${error}`);
  } catch (e) {
    ctx.warn(`Warning: ${e.message}`);
  }
  const labels = new Set(agents.listAgentLabels(ctx));
  for (const job of jobs.listJobs(ctx).jobs) labels.add(jobLabel(job.id));
  for (const label of labels) agents.removeAgent(ctx, label);
  const rmArgs = ['-f', `${SUDOERS_DIR}/${sudoersFileName(ctx.username)}`];
  const removed = macos.sudo(ctx, 'rm', rmArgs, { prompt: ctx.interactive });
  if (removed.code !== 0) throw macos.failure('rm', rmArgs, removed);
  ctx.out(`Cancelled ${cancelled} wake-up(s), removed ${labels.size} agent(s) and the sudoers rule.`);
  ctx.out(`Your scripts, jobs and logs are still in ${ctx.root}. Delete that folder to remove wakecron completely.`);
  return 0;
}

const COMMANDS = {
  setup: cmdSetup, add: cmdAdd, list: cmdList, run: cmdRun, remove: cmdRemove, rm: cmdRemove,
  sync: cmdSync, uninstall: cmdUninstall,
};

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
