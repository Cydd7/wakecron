#!/usr/bin/env node
'use strict';
// Backs up the Apple Shortcuts library into daily, weekly and monthly copies.
// A step of scripts/morning.sh. Design: docs/superpowers/specs/2026-11-06-morning-routine-design.md

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const KINDS = ['daily', 'weekly', 'monthly'];
const DATED = /^\d{4}-\d{2}-\d{2}$/;
const ARCHIVE = 'Shortcuts.sqlite.gz';
const NAMES_FILE = 'shortcut-names.txt';

// ---- Dates (pure) -------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

// The local calendar date of `date`, as YYYY-MM-DD.
function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Calendar arithmetic on YYYY-MM-DD strings, done in UTC so time zones and DST can't shift it.
function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const formatDay = (date) => date.toISOString().slice(0, 10);

function addDays(day, n) {
  const date = parseDay(day);
  date.setUTCDate(date.getUTCDate() + n);
  return formatDay(date);
}

// The Monday on or before `day`; weeks run Monday to Sunday.
function mondayOf(day) {
  return addDays(day, -((parseDay(day).getUTCDay() + 6) % 7));
}

// ---- Rotation (pure) ----------------------------------------------------------------------

// Decides what one run does, given today's date and the folder names already in daily/,
// weekly/ and monthly/. Only YYYY-MM-DD names up to today count; anything else, including a
// folder dated in the future by a wrong clock, is never counted or pruned.
function planRotation({ today, existing, keep }) {
  const dated = {};
  for (const kind of KINDS) dated[kind] = existing[kind].filter((name) => DATED.test(name) && name <= today);

  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  const weekly = !dated.weekly.some((d) => d >= monday && d <= sunday);
  const monthly = !dated.monthly.some((d) => d.startsWith(today.slice(0, 7)));

  const after = {
    daily: [...dated.daily, today],
    weekly: weekly ? [...dated.weekly, today] : dated.weekly,
    monthly: monthly ? [...dated.monthly, today] : dated.monthly,
  };
  const prune = {};
  for (const kind of KINDS) {
    const newestFirst = [...new Set(after[kind])].sort().reverse();
    prune[kind] = newestFirst.slice(keep[kind]).sort();
  }
  return { replaceDaily: dated.daily.includes(today), weekly, monthly, prune };
}

// ---- Options (pure) -----------------------------------------------------------------------

const USAGE = [
  'usage: node morning/backup-shortcuts.js [--to DIR] [--daily N] [--weekly N] [--monthly N]',
  'Backs up all your Apple Shortcuts into DIR/daily, DIR/weekly and DIR/monthly.',
  '  --to DIR      backup folder (default: ~/Documents/Backups/Shortcuts)',
  '  --daily N     daily backups to keep (default: 7)',
  '  --weekly N    weekly backups to keep (default: 4)',
  '  --monthly N   monthly backups to keep (default: 12)',
].join('\n');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const VALUE_OPTIONS = ['to', ...KINDS];

function parseOptions(argv, home, cwd = process.cwd()) {
  const options = { help: false, to: path.join(home, 'Documents', 'Backups', 'Shortcuts'), keep: { daily: 7, weekly: 4, monthly: 12 } };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('-')) throw new UsageError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (!arg.startsWith('--') || !VALUE_OPTIONS.includes(name)) throw new UsageError(`unknown option "${arg}"`);
    let value;
    if (eq !== -1) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length) value = argv[(i += 1)];
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);

    if (name === 'to') {
      const expanded = value === '~' || value.startsWith('~/') ? home + value.slice(1) : value;
      options.to = path.resolve(cwd, expanded);
    } else {
      const count = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!(count >= 1 && count <= 999)) throw new UsageError(`--${name} must be a whole number from 1 to 999 (got "${value}")`);
      options.keep[name] = count;
    }
  }
  return options;
}

// ---- Output text (pure) -------------------------------------------------------------------

// The output of `shortcuts list`: one name per line, kept exactly, sorted without regard to case.
function parseNames(text) {
  const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return text.split('\n')
    .filter((line) => line.trim() !== '')
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || byCodePoint(a, b));
}

// Decimal units, like Finder.
function formatSize(bytes) {
  const kb = Math.round(bytes / 1000);
  if (kb < 1000) return `${Math.max(1, kb)} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function tildePath(p, home) {
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summaryLines({ count, size, folder, replaced, weekly, monthly, removed }) {
  const what = count === null ? 'your Shortcuts library' : plural(count, 'shortcut');
  const lines = [`Backed up ${what} (${size}) to ${folder}${replaced ? " (replaced today's earlier backup)" : ''}`];
  if (weekly && monthly) lines.push("Also this week's and this month's backup.");
  else if (weekly) lines.push("Also this week's backup.");
  else if (monthly) lines.push("Also this month's backup.");
  if (removed.length > 0) lines.push(`Removed ${plural(removed.length, 'old backup')}: ${removed.join(', ')}`);
  return lines;
}

// ---- The run ------------------------------------------------------------------------------

// A problem the person can fix; main prints its message and exits 1.
class Failure extends Error {}

const LEFTOVER_MS = 60 * 60 * 1000;

function withDefaults(ctx) {
  return {
    env: process.env,
    now: () => new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    checkAccess: (file) => fs.closeSync(fs.openSync(file, 'r')),
    nodePath: process.execPath,
    tmpDir: os.tmpdir(),
    timeouts: { copy: 300000, names: 60000 },
    ...ctx,
  };
}

function runTool(ctx, tool, args, timeout) {
  return spawnSync(tool, args, { env: ctx.env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
}

// A path as one argument of a sqlite3 dot-command: double-quoted, with \ and " escaped.
const dotQuote = (p) => `"${p.replace(/[\\"]/g, '\\$&')}"`;

// Folder names in dir (directories only); a missing dir has none.
function listFolders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// A private staging folder inside dir, renamed into place once it is complete.
function stage(dir, staged) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folder = fs.mkdtempSync(path.join(dir, '.incoming-'));
  staged.push(folder);
  return folder;
}

const firstLine = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean);

// Why a tool run failed, in a few words.
function failureReason(result) {
  if (result.error && result.error.code === 'ETIMEDOUT') return 'timed out';
  if (result.error) return result.error.message;
  return firstLine(result.stderr) || (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`);
}

function fullDiskAccessMessage(ctx, folder) {
  let node = ctx.nodePath;
  try {
    node = fs.realpathSync(ctx.nodePath);
  } catch {
    // keep the path as given
  }
  return [
    `macOS blocked access to ${folder} (operation not permitted).`,
    'Give node Full Disk Access once: System Settings → Privacy & Security → Full Disk Access →',
    `click + → press ⌘⇧G → paste ${node} → Open, and make sure its switch is on.`,
    'Started it from Terminal? Then Terminal needs Full Disk Access instead.',
    'After a Homebrew upgrade of node, macOS forgets this; do it again with the new path.',
  ].join('\n');
}

// Step 1: can we read the library at all? Runs before anything touches the backup folder.
function checkLibrary(library, ctx, home) {
  try {
    ctx.checkAccess(library);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Failure(`no Shortcuts library at ${tildePath(library, home)}. Open the Shortcuts app once, then try again.`);
    if (e.code === 'EPERM') throw new Failure(fullDiskAccessMessage(ctx, tildePath(path.dirname(library), home)));
    throw new Failure(`can't read ${tildePath(library, home)}: ${e.message}`);
  }
}

// Step 2: staging folders left by a run that crashed, once they are an hour old. File times are
// real-clock values, so this uses the real clock, not ctx.now(). Best effort.
function tidy(to) {
  const cutoff = Date.now() - LEFTOVER_MS;
  for (const kind of KINDS) {
    const dir = path.join(to, kind);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\.(incoming|replaced)-/.test(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      try {
        if (fs.statSync(abs).mtimeMs < cutoff) fs.rmSync(abs, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

// sqlite3 would otherwise first run the person's ~/.sqliterc, and settings like `.headers on`
// change what the check prints.
const NO_STARTUP_FILE = ['-init', '/dev/null'];

// Steps 3-5: a checked copy of the library in temp, and the shortcut names (null if unavailable).
function snapshot(library, temp, ctx) {
  const copy = path.join(temp, 'Shortcuts.sqlite');
  const copied = runTool(ctx, 'sqlite3', [...NO_STARTUP_FILE, '-readonly', '-cmd', '.timeout 10000', library, `.backup ${dotQuote(copy)}`], ctx.timeouts.copy);
  if (copied.error && copied.error.code === 'ENOENT') throw new Failure('sqlite3 not found. It ships with macOS at /usr/bin/sqlite3; check PATH.');
  if (copied.error || copied.status !== 0) throw new Failure(`sqlite3 couldn't copy the library: ${failureReason(copied)}`);

  const checked = runTool(ctx, 'sqlite3', [...NO_STARTUP_FILE, '-readonly', copy, 'PRAGMA quick_check;'], ctx.timeouts.copy);
  if (checked.error || checked.status !== 0 || checked.stdout.trim() !== 'ok') {
    const detail = firstLine(checked.stdout) || firstLine(checked.stderr) || failureReason(checked);
    throw new Failure(`the copy failed SQLite's integrity check (${detail}). Nothing was replaced.`);
  }

  const listed = runTool(ctx, 'shortcuts', ['list'], ctx.timeouts.names);
  if (!listed.error && listed.status === 0) return { copy, names: parseNames(listed.stdout) };
  const why = listed.error && listed.error.code === 'ENOENT' ? 'shortcuts not found' : failureReason(listed);
  ctx.stderr.write(`backup-shortcuts: warning: couldn't list shortcut names (${why}); the backup is saved without ${NAMES_FILE}\n`);
  return { copy, names: null };
}

// Steps 6-8: save today's daily backup, promote it, prune. Nothing is pruned unless saving and
// promoting succeeded; a failure removes this run's staging folders and leaves the rest alone.
function store(opts, today, copy, names, staged) {
  // Only folders holding an archive are backups; a dated folder without one is the person's own.
  const existing = {};
  for (const kind of KINDS) {
    const dir = path.join(opts.to, kind);
    existing[kind] = listFolders(dir).filter((name) => fs.existsSync(path.join(dir, name, ARCHIVE)));
  }
  const plan = planRotation({ today, existing, keep: opts.keep });

  const dailyDir = path.join(opts.to, 'daily');
  const incoming = stage(dailyDir, staged);
  fs.writeFileSync(path.join(incoming, ARCHIVE), zlib.gzipSync(fs.readFileSync(copy)), { mode: 0o600 });
  if (names) fs.writeFileSync(path.join(incoming, NAMES_FILE), names.length > 0 ? `${names.join('\n')}\n` : '', { mode: 0o600 });
  const saved = path.join(dailyDir, today);
  if (plan.replaceDaily) {
    const aside = path.join(dailyDir, `.replaced-${crypto.randomBytes(4).toString('hex')}`);
    fs.renameSync(saved, aside);
    try {
      fs.renameSync(incoming, saved);
    } catch (e) {
      fs.renameSync(aside, saved); // put today's earlier backup back
      throw e;
    }
    fs.rmSync(aside, { recursive: true, force: true });
  } else {
    fs.renameSync(incoming, saved);
  }

  for (const kind of ['weekly', 'monthly']) {
    if (!plan[kind]) continue;
    const dir = path.join(opts.to, kind);
    const promoting = stage(dir, staged);
    for (const name of fs.readdirSync(saved)) {
      fs.copyFileSync(path.join(saved, name), path.join(promoting, name), fs.constants.COPYFILE_FICLONE);
    }
    fs.renameSync(promoting, path.join(dir, today));
  }

  const removed = [];
  for (const kind of KINDS) {
    for (const date of plan.prune[kind]) {
      fs.rmSync(path.join(opts.to, kind, date), { recursive: true, force: true });
      removed.push(`${kind}/${date}`);
    }
  }
  return { saved, plan, removed };
}

// One backup run (spec §5.2). Returns what summaryLines reports.
function backup(opts, ctx, home) {
  const library = path.join(home, 'Library', 'Shortcuts', 'Shortcuts.sqlite');
  const today = localDate(ctx.now());
  checkLibrary(library, ctx, home);
  tidy(opts.to);

  const temp = fs.mkdtempSync(path.join(ctx.tmpDir, 'backup-shortcuts-'));
  try {
    const { copy, names } = snapshot(library, temp, ctx);
    const staged = [];
    let stored;
    try {
      stored = store(opts, today, copy, names, staged);
    } catch (e) {
      for (const folder of staged) fs.rmSync(folder, { recursive: true, force: true });
      throw new Failure(`can't write to ${tildePath(opts.to, home)}: ${e.message}`);
    }
    const { saved, plan, removed } = stored;
    return {
      count: names ? names.length : null,
      size: formatSize(fs.statSync(path.join(saved, ARCHIVE)).size),
      folder: tildePath(saved, home),
      replaced: plan.replaceDaily,
      weekly: plan.weekly,
      monthly: plan.monthly,
      removed,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main(argv, ctx = {}) {
  const c = withDefaults(ctx);
  const home = c.env.HOME || os.homedir();
  try {
    const opts = parseOptions(argv, home);
    if (opts.help) {
      c.stdout.write(`${USAGE}\n`);
      return 0;
    }
    for (const line of summaryLines(backup(opts, c, home))) c.stdout.write(`${line}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      c.stderr.write(`backup-shortcuts: ${e.message}\n${USAGE.split('\n')[0]}\n`);
      return 2;
    }
    if (e instanceof Failure) {
      c.stderr.write(`backup-shortcuts: ${e.message}\n`);
      return 1;
    }
    c.stderr.write(`backup-shortcuts: unexpected error: ${e.message}\n`);
    return 1;
  }
}

module.exports = {
  localDate, mondayOf, planRotation,
  USAGE, UsageError, parseOptions, parseNames, formatSize, tildePath, summaryLines,
  main,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
