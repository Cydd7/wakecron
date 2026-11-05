'use strict';
// Every location wakecron uses, plus the context object that carries paths, tool paths, the
// clock and IO into the modules that touch the system. createContext touches no files.
const os = require('node:os');
const path = require('node:path');

const LABEL_PREFIX = 'local.wakecron.';
const SYNC_LABEL = 'local.wakecron.sync';
const PMSET_OWNER = 'wakecron';
const SUDOERS_DIR = '/etc/sudoers.d';
const TOOL_PATHS = {
  launchctl: '/bin/launchctl',
  pmset: '/usr/bin/pmset',
  caffeinate: '/usr/bin/caffeinate',
  osascript: '/usr/bin/osascript',
  sudo: '/usr/bin/sudo',
  visudo: '/usr/sbin/visudo',
  install: '/usr/bin/install',
  rm: '/bin/rm',
  bash: '/bin/bash',
};

// Tests point WAKECRON_BIN_DIR at stand-ins for the macOS tools; bash is always the real one.
function toolPaths(env) {
  const dir = env.WAKECRON_BIN_DIR;
  if (!dir) return { ...TOOL_PATHS };
  const tools = {};
  for (const name of Object.keys(TOOL_PATHS)) tools[name] = name === 'bash' ? TOOL_PATHS.bash : path.join(dir, name);
  return tools;
}

function currentUsername(env) {
  try {
    return os.userInfo().username;
  } catch {
    return env.USER || '';
  }
}

function createContext({
  root = path.resolve(__dirname, '..'),
  home = os.homedir(),
  env = process.env,
  now = () => new Date(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  interactive = Boolean(stdin.isTTY && stdout.isTTY),
  username = currentUsername(env),
  nodePath = process.execPath,
  uid = process.getuid ? process.getuid() : 0,
} = {}) {
  const logsDir = path.join(root, 'logs');
  const stateDir = path.join(root, 'state');
  return {
    root, home, env, now, stdin, stdout, stderr, interactive, username, nodePath, uid,
    paths: {
      root,
      entry: path.join(root, 'wakecron'),
      scriptsDir: path.join(root, 'scripts'),
      jobsDir: path.join(root, 'jobs'),
      logsDir,
      stateDir,
      wakesFile: path.join(stateDir, 'wakes.json'),
      wakesLock: path.join(stateDir, 'wakes.lock'),
      launchdLog: path.join(logsDir, 'launchd.log'),
      agentsDir: path.join(home, 'Library', 'LaunchAgents'),
    },
    tools: toolPaths(env),
    cache: {},
    out(line) { stdout.write(`${line}\n`); },
    warn(line) { stderr.write(`${line}\n`); },
  };
}

const jobLabel = (id) => `${LABEL_PREFIX}${id}`;
const agentPlistPath = (ctx, label) => path.join(ctx.paths.agentsDir, `${label}.plist`);
const jobFile = (ctx, id) => path.join(ctx.paths.jobsDir, `${id}.json`);
const logFile = (ctx, id) => path.join(ctx.paths.logsDir, `${id}.log`);
const lastRunFile = (ctx, id) => path.join(ctx.paths.logsDir, `${id}.last.json`);

module.exports = {
  LABEL_PREFIX, SYNC_LABEL, PMSET_OWNER, SUDOERS_DIR, TOOL_PATHS,
  createContext, jobLabel, agentPlistPath, jobFile, logFile, lastRunFile,
};
