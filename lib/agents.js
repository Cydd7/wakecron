'use strict';
// LaunchAgents: what each job's agent contains, and installing/removing agents with launchctl.
const fs = require('node:fs');
const path = require('node:path');
const { toPlistXml } = require('./plist');
const { calendarIntervals } = require('./schedule');
const { LABEL_PREFIX, SYNC_LABEL, jobLabel, agentPlistPath } = require('./paths');
const { ensureDir, writeFileAtomic } = require('./util');
const macos = require('./macos');

const DEFAULT_PATH_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// The environment a job's script gets: the terminal's PATH first (so tools behave as they do
// for you), then the standard folders, plus LANG when it is set.
function captureEnv(env) {
  const dirs = [...String(env.PATH || '').split(':'), ...DEFAULT_PATH_DIRS].filter(Boolean);
  const captured = { PATH: [...new Set(dirs)].join(':') };
  if (env.LANG) captured.LANG = env.LANG;
  return captured;
}

function jobAgentObject(job) {
  const launchdLog = path.join(job.root, 'logs', 'launchd.log');
  return {
    Label: jobLabel(job.id),
    ProgramArguments: [job.node, path.join(job.root, 'wakecron'), 'run', job.id, '--scheduled'],
    StartCalendarInterval: calendarIntervals(job.schedule),
    EnvironmentVariables: job.env,
    StandardOutPath: launchdLog,
    StandardErrorPath: launchdLog,
  };
}

// The login agent: re-arms wake-ups each time you log in (covers wake-ups missed while off).
function syncAgentObject(ctx) {
  return {
    Label: SYNC_LABEL,
    ProgramArguments: [ctx.nodePath, ctx.paths.entry, 'sync', '--wakes-only'],
    RunAtLoad: true,
    EnvironmentVariables: captureEnv(ctx.env),
    StandardOutPath: ctx.paths.launchdLog,
    StandardErrorPath: ctx.paths.launchdLog,
  };
}

function installAgent(ctx, label, obj) {
  ensureDir(ctx.paths.agentsDir);
  ensureDir(ctx.paths.logsDir); // launchd can't open StandardOutPath in a missing folder
  const file = agentPlistPath(ctx, label);
  writeFileAtomic(file, toPlistXml(obj));
  macos.bootout(ctx, label); // not loaded is fine
  const result = macos.bootstrap(ctx, file);
  if (result.code !== 0) throw macos.failure('launchctl', ['bootstrap', `gui/${ctx.uid}`, file], result);
}

function removeAgent(ctx, label) {
  macos.bootout(ctx, label);
  fs.rmSync(agentPlistPath(ctx, label), { force: true });
}

function listAgentLabels(ctx) {
  let names;
  try {
    names = fs.readdirSync(ctx.paths.agentsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(LABEL_PREFIX) && name.endsWith('.plist') && name.length > LABEL_PREFIX.length + '.plist'.length)
    .map((name) => name.slice(0, -'.plist'.length))
    .sort();
}

module.exports = { DEFAULT_PATH_DIRS, captureEnv, jobAgentObject, syncAgentObject, installAgent, removeAgent, listAgentLabels };
