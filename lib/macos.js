'use strict';
// The only module that runs external commands. Every call is an argv array (never a shell
// string) and passes the context's environment. Results are { code, stdout, stderr }.
const { spawn, spawnSync } = require('node:child_process');
const { PMSET_OWNER } = require('./paths');

const SUDO_PROBE_DATE = '01/01/30 00:00:00';

function run(ctx, tool, args, { stdio = 'pipe', input } = {}) {
  const r = spawnSync(ctx.tools[tool], args, { env: ctx.env, encoding: 'utf8', stdio, input });
  if (r.error) return { code: r.error.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: r.error.message };
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Without `prompt`, sudo must not ask for a password (-n). With it, sudo may prompt on the terminal.
function sudo(ctx, tool, args, { prompt = false } = {}) {
  const command = [ctx.tools[tool], ...args];
  return prompt ? run(ctx, 'sudo', command, { stdio: 'inherit' }) : run(ctx, 'sudo', ['-n', ...command]);
}

function failure(tool, args, result) {
  const detail = String(result.stderr || '').trim();
  return new Error(`${tool} ${args.join(' ')} exited ${result.code}${detail ? `: ${detail}` : ''}`);
}

// True when the sudoers rule from `setup` lets us schedule wake-ups without a password.
// -k makes sudo ignore credentials cached by a recent password prompt, which would otherwise make
// this check pass for any admin whether or not the rule is active.
function canSudoPmset(ctx) {
  if (ctx.cache.sudoPmset === undefined) {
    const probe = ['-n', '-k', '-l', ctx.tools.pmset, 'schedule', 'wake', SUDO_PROBE_DATE, PMSET_OWNER];
    ctx.cache.sudoPmset = run(ctx, 'sudo', probe).code === 0;
  }
  return ctx.cache.sudoPmset;
}

function pmsetWake(ctx, date, { cancel = false, prompt = false } = {}) {
  return sudo(ctx, 'pmset', ['schedule', ...(cancel ? ['cancel'] : []), 'wake', date, PMSET_OWNER], { prompt });
}

function pmsetSchedLines(ctx) {
  const r = run(ctx, 'pmset', ['-g', 'sched']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map((line) => line.trim()).filter((line) => line.includes(`'${PMSET_OWNER}'`));
}

const domain = (ctx) => `gui/${ctx.uid}`;

function bootstrap(ctx, plistPath) {
  return run(ctx, 'launchctl', ['bootstrap', domain(ctx), plistPath]);
}

function bootout(ctx, label) {
  return run(ctx, 'launchctl', ['bootout', `${domain(ctx)}/${label}`]);
}

// Used by a job to unload itself: a separate process group survives launchd stopping the job.
function bootoutDetached(ctx, label) {
  const child = spawn(ctx.tools.launchctl, ['bootout', `${domain(ctx)}/${label}`], { detached: true, stdio: 'ignore', env: ctx.env });
  child.on('error', () => {});
  child.unref();
}

function isLoaded(ctx, label) {
  return run(ctx, 'launchctl', ['print', `${domain(ctx)}/${label}`]).code === 0;
}

// The text travels as arguments, so quotes in it can't break out of the AppleScript.
function notify(ctx, title, message) {
  run(ctx, 'osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run', title, message]);
}

// Keeps the Mac awake (idle and, on power, system sleep) until `pid` exits.
function startCaffeinate(ctx, pid) {
  try {
    const child = spawn(ctx.tools.caffeinate, ['-i', '-s', '-w', String(pid)], { stdio: 'ignore', env: ctx.env });
    child.on('error', () => {});
    return child;
  } catch {
    return null;
  }
}

module.exports = {
  run, sudo, failure, canSudoPmset, pmsetWake, pmsetSchedLines,
  bootstrap, bootout, bootoutDetached, isLoaded, notify, startCaffeinate,
};
