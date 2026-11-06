#!/usr/bin/env node
'use strict';
// Backs up the Apple Shortcuts library into daily, weekly and monthly copies.
// A step of scripts/morning.sh. Design: docs/superpowers/specs/2026-11-06-morning-routine-design.md

const path = require('node:path');

const KINDS = ['daily', 'weekly', 'monthly'];
const DATED = /^\d{4}-\d{2}-\d{2}$/;

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
// weekly/ and monthly/. Only YYYY-MM-DD names count; anything else is never counted or pruned.
function planRotation({ today, existing, keep }) {
  const dated = {};
  for (const kind of KINDS) dated[kind] = existing[kind].filter((name) => DATED.test(name));

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

module.exports = {
  localDate, mondayOf, planRotation,
  USAGE, UsageError, parseOptions, parseNames, formatSize, tildePath, summaryLines,
};
