'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const {
  localDate, mondayOf, planRotation,
  USAGE, parseOptions, parseNames, formatSize, tildePath, summaryLines,
  main,
} = require('../scripts/morning/backup-shortcuts');

// ---- Helpers --------------------------------------------------------------------------------

const FAKE_TOOLS = path.join(__dirname, 'fakes', 'backup-tools.js');
const MAC_SQLITE = path.join(__dirname, 'fakes', 'mac-sqlite3.js');
const FRI_7AM = new Date(2026, 10, 6, 7, 0);
const NAMES = 'Morning Weather\nbackup notes\nZoom Link\n';
const HAS_SQLITE = spawnSync('sqlite3', ['-version']).status === 0;
const SQLITE_DIR = HAS_SQLITE ? path.dirname(spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).stdout.trim()) : null;

const sandboxes = [];
process.on('exit', () => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

const capture = () => ({ text: '', write(chunk) { this.text += chunk; } });

// A throwaway HOME with a Shortcuts library, a bin/ of stand-in tools and a private temp folder.
// realSqlite: true puts this machine's sqlite3 on PATH; 'mac' puts it there acting like the Mac's.
function sandbox({ library = 'library v1', tools = ['sqlite3', 'shortcuts'], realSqlite = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-')));
  sandboxes.push(dir);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const tmp = path.join(dir, 'tmp');
  for (const d of [home, bin, tmp]) fs.mkdirSync(d);
  const libraryPath = path.join(home, 'Library', 'Shortcuts', 'Shortcuts.sqlite');
  if (typeof library === 'string') {
    fs.mkdirSync(path.dirname(libraryPath), { recursive: true });
    fs.writeFileSync(libraryPath, library);
  }
  for (const tool of tools) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TOOLS}" ${tool} "$@"\n`, { mode: 0o755 });
  }
  if (realSqlite === 'mac') {
    fs.writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/sh\nexec "${process.execPath}" "${MAC_SQLITE}" "${path.join(SQLITE_DIR, 'sqlite3')}" "$@"\n`, { mode: 0o755 });
  }
  const log = path.join(dir, 'calls.jsonl');
  const env = { PATH: realSqlite ? `${bin}:${SQLITE_DIR}` : bin, HOME: home, FAKE_LOG: log, FAKE_NAMES: NAMES };
  return {
    dir, home, bin, tmp, to: path.join(home, 'Documents', 'Backups', 'Shortcuts'), library: libraryPath, log, env,
    run(argv = [], { env: extra = {}, now = FRI_7AM, ...rest } = {}) {
      const stdout = capture();
      const stderr = capture();
      const code = main(argv, { env: { ...env, ...extra }, now: () => now, stdout, stderr, tmpDir: tmp, ...rest });
      return { code, stdout: stdout.text, stderr: stderr.text };
    },
    calls(tool) {
      let lines;
      try {
        lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
      return lines.map((line) => JSON.parse(line)).filter(([t]) => t === tool).map(([, ...args]) => args);
    },
  };
}

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(file)).toString();

// Every path below root mapped to 'dir' or to the file's contents ({} when root is missing).
function tree(root) {
  const found = {};
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found[rel] = 'dir';
        walk(abs, rel);
      } else {
        found[rel] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(root, '');
  return found;
}

// Older backups (each holding an archive) that a failed run must leave exactly as they are.
function seedBackups(to) {
  for (const rel of ['daily/2026-10-31', 'daily/2026-11-01', 'daily/2026-11-02', 'daily/2026-11-03', 'daily/2026-11-04', 'weekly/2026-10-26', 'monthly/2026-10-01']) {
    fs.mkdirSync(path.join(to, rel), { recursive: true });
    fs.writeFileSync(path.join(to, rel, 'Shortcuts.sqlite.gz'), rel);
  }
}

// The real sqlite3, for tests that need SQLite's own behaviour.
function sqlite(db, sql) {
  const r = spawnSync('sqlite3', ['-init', '/dev/null', db, sql], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// Keeps a real sqlite3 connection open on db after running sql in it, like the Shortcuts app does.
async function holdOpen(db, sql) {
  const child = spawn('sqlite3', ['-init', '/dev/null', db], { stdio: ['pipe', 'ignore', 'inherit'] });
  child.stdin.write(`${sql}\n`);
  const closed = new Promise((resolve) => child.on('close', resolve));
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = spawnSync('sqlite3', ['-init', '/dev/null', '-readonly', db, 'SELECT count(*) FROM ZSHORTCUT;'], { encoding: 'utf8' });
    if (r.stdout.trim() === '3') break;
    if (Date.now() > deadline) throw new Error(`holdOpen: the rows never appeared (${r.stdout}${r.stderr})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { close: () => { child.stdin.end(); return closed; } };
}

const KEEP = { daily: 7, weekly: 4, monthly: 12 };
const none = { daily: [], weekly: [], monthly: [] };
const withTZ = (tz, fn) => {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
};

test('localDate is the local calendar date', () => {
  assert.equal(localDate(new Date(2026, 10, 6, 7, 0)), '2026-11-06');
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  withTZ('America/New_York', () => {
    assert.equal(localDate(new Date('2026-11-01T04:30:00Z')), '2026-11-01'); // the night US DST ends
    assert.equal(localDate(new Date('2026-11-01T03:30:00Z')), '2026-10-31');
  });
});

test('mondayOf finds the Monday that starts the week, in any time zone', () => {
  for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney']) {
    withTZ(tz, () => {
      assert.equal(mondayOf('2026-11-06'), '2026-11-02'); // Friday
      assert.equal(mondayOf('2026-11-02'), '2026-11-02'); // Monday
      assert.equal(mondayOf('2026-11-08'), '2026-11-02'); // Sunday
      assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // US DST ends
      assert.equal(mondayOf('2026-10-25'), '2026-10-19'); // EU DST ends
      assert.equal(mondayOf('2027-01-01'), '2026-12-28');
    });
  }
});

test('the first run ever makes a daily, a weekly and a monthly backup', () => {
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: none, keep: KEEP }),
    { replaceDaily: false, weekly: true, monthly: true, prune: { daily: [], weekly: [], monthly: [] } });
});

test('later days in the same week and month make only a daily backup', () => {
  const existing = { daily: ['2026-11-06'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  const plan = planRotation({ today: '2026-11-08', existing, keep: KEEP });
  assert.equal(plan.replaceDaily, false);
  assert.equal(plan.weekly, false);
  assert.equal(plan.monthly, false);
});

test('Monday starts a new week', () => {
  const existing = { daily: ['2026-11-08'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  assert.equal(planRotation({ today: '2026-11-09', existing, keep: KEEP }).weekly, true);
});

test('a new month gets a monthly backup; the week keeps its earlier weekly', () => {
  const existing = { daily: ['2026-11-30'], weekly: ['2026-11-30'], monthly: ['2026-11-06'] };
  const plan = planRotation({ today: '2026-12-01', existing, keep: KEEP });
  assert.equal(plan.monthly, true);
  assert.equal(plan.weekly, false);
});

test('a week that spans New Year is one week', () => {
  const existing = { daily: ['2026-12-31'], weekly: ['2026-12-28'], monthly: ['2026-12-01'] };
  const plan = planRotation({ today: '2027-01-01', existing, keep: KEEP });
  assert.equal(plan.weekly, false);
  assert.equal(plan.monthly, true);
});

test('a second run on the same day replaces the daily backup only', () => {
  const existing = { daily: ['2026-11-06'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  assert.deepEqual(planRotation({ today: '2026-11-06', existing, keep: KEEP }),
    { replaceDaily: true, weekly: false, monthly: false, prune: { daily: [], weekly: [], monthly: [] } });
});

test('pruning keeps the newest N by count', () => {
  const daily = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: { ...none, daily }, keep: KEEP }).prune.daily, ['2026-10-28', '2026-10-29']);
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: { ...none, daily: daily.slice(-3) }, keep: KEEP }).prune.daily, []);
});

test("names it didn't create are never counted or pruned", () => {
  const daily = ['notes.txt', '2026-11-06-old', '.incoming-x', 'before-restore-20261101-120000', '2026-11-01', '2026-11-02'];
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: { ...none, daily }, keep: { ...KEEP, daily: 1 } }).prune.daily,
    ['2026-11-01', '2026-11-02']);
});

test('folders dated after today are never counted or pruned', () => {
  const plan = planRotation({
    today: '2026-11-06',
    existing: { daily: ['2099-01-01', '2026-11-05'], weekly: ['2026-11-08'], monthly: ['2099-01-01'] },
    keep: { daily: 1, weekly: 4, monthly: 12 },
  });
  assert.deepEqual(plan.prune, { daily: ['2026-11-05'], weekly: [], monthly: [] }); // today's new backup stays
  assert.equal(plan.weekly, true); // a Sunday folder dated in the future isn't this week's backup
  assert.equal(plan.monthly, true);
});

test('lowering a count prunes down to it', () => {
  const daily = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  assert.deepEqual(planRotation({ today: '2026-11-08', existing: { ...none, daily }, keep: { ...KEEP, daily: 3 } }).prune.daily,
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
});

test('a year of daily runs ends with 7 daily, 4 weekly and 12 monthly backups', () => {
  const state = { daily: [], weekly: [], monthly: [] };
  const day = new Date(Date.UTC(2026, 10, 6));
  let today;
  for (let i = 0; i < 400; i += 1, day.setUTCDate(day.getUTCDate() + 1)) {
    today = day.toISOString().slice(0, 10);
    const plan = planRotation({ today, existing: state, keep: KEEP });
    if (!plan.replaceDaily) state.daily.push(today);
    if (plan.weekly) state.weekly.push(today);
    if (plan.monthly) state.monthly.push(today);
    for (const kind of ['daily', 'weekly', 'monthly']) state[kind] = state[kind].filter((d) => !plan.prune[kind].includes(d));
  }
  assert.equal(today, '2027-12-10');
  assert.deepEqual(state.daily, ['2027-12-04', '2027-12-05', '2027-12-06', '2027-12-07', '2027-12-08', '2027-12-09', '2027-12-10']);
  assert.deepEqual(state.weekly, ['2027-11-15', '2027-11-22', '2027-11-29', '2027-12-06']);
  assert.deepEqual(state.monthly, Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}-01`));
});

// ---- Options and output text ----------------------------------------------------------------

const HOME = '/Users/me';

test('options default to the Documents folder and 7/4/12', () => {
  assert.deepEqual(parseOptions([], HOME),
    { help: false, to: '/Users/me/Documents/Backups/Shortcuts', keep: { daily: 7, weekly: 4, monthly: 12 } });
});

test('options take "--name value" and "--name=value"; a leading ~ is home; relative is from cwd', () => {
  assert.deepEqual(parseOptions(['--to', '/x/y', '--daily', '3', '--weekly=2', '--monthly', '24'], HOME),
    { help: false, to: '/x/y', keep: { daily: 3, weekly: 2, monthly: 24 } });
  assert.equal(parseOptions(['--to', '~/B'], HOME).to, '/Users/me/B');
  assert.equal(parseOptions(['--to=~'], HOME).to, '/Users/me');
  assert.equal(parseOptions(['--to', 'rel/dir'], HOME, '/work').to, '/work/rel/dir');
  assert.equal(parseOptions(['-h'], HOME).help, true);
  assert.equal(parseOptions(['--help'], HOME).help, true);
});

test('bad options say exactly what is wrong', () => {
  const bad = (argv, message) => assert.throws(() => parseOptions(argv, HOME), { name: 'UsageError', message });
  bad(['--frobnicate'], 'unknown option "--frobnicate"');
  bad(['extra'], 'unexpected argument "extra"');
  bad(['--to'], '--to needs a value');
  bad(['--to='], '--to needs a value');
  bad(['--daily', '0'], '--daily must be a whole number from 1 to 999 (got "0")');
  bad(['--weekly', '1000'], '--weekly must be a whole number from 1 to 999 (got "1000")');
  bad(['--monthly', '2.5'], '--monthly must be a whole number from 1 to 999 (got "2.5")');
  bad(['--daily', 'seven'], '--daily must be a whole number from 1 to 999 (got "seven")');
});

test('shortcut names are kept exactly, sorted without regard to case', () => { // Review Focus 2
  const names = parseNames('zeta\n\nAlpha\nbeta\nÉcole\nEcho\nAlpha\n  Indented\n🌅 Sunrise\n');
  assert.equal(names.length, 8);
  assert.ok(names.includes('  Indented'));
  assert.ok(names.includes('🌅 Sunrise'));
  assert.deepEqual(names.filter((n) => /^[A-Za-zÉ]/.test(n)), ['Alpha', 'Alpha', 'beta', 'Echo', 'École', 'zeta']);
  assert.deepEqual(parseNames(''), []);
});

test('sizes use decimal units like Finder', () => {
  assert.equal(formatSize(400), '1 KB');
  assert.equal(formatSize(1499), '1 KB');
  assert.equal(formatSize(1500), '2 KB');
  assert.equal(formatSize(999_499), '999 KB');
  assert.equal(formatSize(999_500), '1.0 MB');
  assert.equal(formatSize(1_449_999), '1.4 MB');
  assert.equal(formatSize(12_345_678), '12.3 MB');
});

test('paths under home are shown with ~', () => {
  assert.equal(tildePath('/Users/me/Documents/x', HOME), '~/Documents/x');
  assert.equal(tildePath('/Users/me', HOME), '~');
  assert.equal(tildePath('/Users/meme/x', HOME), '/Users/meme/x');
  assert.equal(tildePath('/Volumes/B', HOME), '/Volumes/B');
});

test('the summary reports what was backed up, promoted and removed', () => {
  const base = {
    count: 87, size: '1.4 MB', folder: '~/Documents/Backups/Shortcuts/daily/2026-11-06',
    replaced: false, weekly: true, monthly: true, removed: ['daily/2026-10-30'],
  };
  assert.deepEqual(summaryLines(base), [
    'Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06',
    "Also this week's and this month's backup.",
    'Removed 1 old backup: daily/2026-10-30',
  ]);
  assert.equal(summaryLines({ ...base, count: 1 })[0], 'Backed up 1 shortcut (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06');
  assert.equal(summaryLines({ ...base, count: null })[0], 'Backed up your Shortcuts library (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06');
  assert.equal(summaryLines({ ...base, replaced: true })[0],
    "Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06 (replaced today's earlier backup)");
  assert.equal(summaryLines({ ...base, monthly: false })[1], "Also this week's backup.");
  assert.equal(summaryLines({ ...base, weekly: false })[1], "Also this month's backup.");
  assert.deepEqual(summaryLines({ ...base, weekly: false, monthly: false, removed: [] }),
    ['Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06']);
  assert.equal(summaryLines({ ...base, removed: ['daily/2026-10-29', 'weekly/2026-10-05'] })[2],
    'Removed 2 old backups: daily/2026-10-29, weekly/2026-10-05');
});

// ---- The backup run -------------------------------------------------------------------------

test('the first run backs up the library into daily, weekly and monthly', () => {
  const sb = sandbox();
  const r = sb.run([]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, "Backed up 3 shortcuts (1 KB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06\nAlso this week's and this month's backup.\n");
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const dir = path.join(sb.to, kind, '2026-11-06');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Shortcuts.sqlite.gz', 'shortcut-names.txt']);
    assert.equal(gunzip(path.join(dir, 'Shortcuts.sqlite.gz')), 'library v1');
    assert.equal(fs.readFileSync(path.join(dir, 'shortcut-names.txt'), 'utf8'), 'backup notes\nMorning Weather\nZoom Link\n');
  }
});

test('backups are private: folders 0700, files 0600', () => {
  const sb = sandbox();
  sb.run([]);
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(sb.to), 0o700);
  for (const kind of ['daily', 'weekly', 'monthly']) {
    assert.equal(mode(path.join(sb.to, kind)), 0o700);
    assert.equal(mode(path.join(sb.to, kind, '2026-11-06')), 0o700);
    for (const f of ['Shortcuts.sqlite.gz', 'shortcut-names.txt']) assert.equal(mode(path.join(sb.to, kind, '2026-11-06', f)), 0o600);
  }
});

test('sqlite3 copies the library read-only with a busy timeout, then checks the copy as one immutable file', () => {
  const sb = sandbox();
  sb.run([]);
  const [copy, check] = sb.calls('sqlite3');
  assert.deepEqual(copy.slice(0, 6), ['-init', '/dev/null', '-readonly', '-cmd', '.timeout 10000', sb.library]);
  assert.ok(copy[6].startsWith(`.backup "${sb.tmp}/backup-shortcuts-`), copy[6]);
  assert.ok(copy[6].endsWith('/Shortcuts.sqlite"'), copy[6]);
  assert.deepEqual(check, ['-init', '/dev/null', '-readonly', `file://${copy[6].slice(9, -1)}?immutable=1`, 'PRAGMA quick_check;']);
  assert.deepEqual(sb.calls('shortcuts'), [['list']]);
  assert.deepEqual(fs.readdirSync(sb.tmp), []); // the temporary copy is gone
});

test('a later day in the same week makes only a daily backup', () => {
  const sb = sandbox();
  sb.run([]);
  const r = sb.run([], { now: new Date(2026, 10, 7, 7, 0) });
  assert.equal(r.stdout, 'Backed up 3 shortcuts (1 KB) to ~/Documents/Backups/Shortcuts/daily/2026-11-07\n');
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'weekly')), ['2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'monthly')), ['2026-11-06']);
});

test("a second run the same day replaces that day's backup; this week's and month's keep the first", () => { // Review Focus 3
  const sb = sandbox();
  sb.run([]);
  fs.writeFileSync(sb.library, 'library v2');
  const r = sb.run([], { now: new Date(2026, 10, 6, 9, 30) });
  assert.equal(r.stdout, "Backed up 3 shortcuts (1 KB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06 (replaced today's earlier backup)\n");
  assert.equal(gunzip(path.join(sb.to, 'daily/2026-11-06/Shortcuts.sqlite.gz')), 'library v2');
  for (const kind of ['weekly', 'monthly']) assert.equal(gunzip(path.join(sb.to, kind, '2026-11-06/Shortcuts.sqlite.gz')), 'library v1');
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily')), ['2026-11-06']); // no .replaced-* left
});

test('six weeks of mornings keep the newest 7 daily and 4 weekly backups', () => {
  const sb = sandbox();
  for (let i = 0; i < 42; i += 1) {
    const r = sb.run([], { now: new Date(2026, 10, 6 + i, 7, 0) });
    assert.equal(r.code, 0, r.stderr);
    if (i === 7) assert.match(r.stdout, /^Removed 1 old backup: daily\/2026-11-06$/m);
  }
  const list = (kind) => fs.readdirSync(path.join(sb.to, kind)).sort();
  assert.deepEqual(list('daily'), ['2026-12-11', '2026-12-12', '2026-12-13', '2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17']);
  assert.deepEqual(list('weekly'), ['2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14']);
  assert.deepEqual(list('monthly'), ['2026-11-06', '2026-12-01']);
});

test("never counts or deletes things it didn't create", () => { // Review Focus 4
  const sb = sandbox();
  const daily = path.join(sb.to, 'daily');
  for (const d of ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
    fs.mkdirSync(path.join(daily, d), { recursive: true });
    fs.writeFileSync(path.join(daily, d, 'Shortcuts.sqlite.gz'), 'an earlier backup');
  }
  fs.mkdirSync(path.join(daily, 'notes'));
  fs.mkdirSync(path.join(daily, '2026-11-01-old'));
  fs.writeFileSync(path.join(daily, '2026-10-01'), 'a file, not a backup');
  fs.mkdirSync(path.join(sb.to, 'before-restore-20261101-120000'));
  const r = sb.run([]);
  assert.match(r.stdout, /^Removed 2 old backups: daily\/2026-10-29, daily\/2026-10-30$/m);
  assert.deepEqual(fs.readdirSync(daily).sort(),
    ['2026-10-01', '2026-10-31', '2026-11-01', '2026-11-01-old', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', 'notes']);
  assert.ok(fs.existsSync(path.join(sb.to, 'before-restore-20261101-120000')));
});

test('a folder dated in the future never pushes out the new backup', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.to, 'daily', '2099-01-01'), { recursive: true });
  fs.writeFileSync(path.join(sb.to, 'daily', '2099-01-01', 'Shortcuts.sqlite.gz'), 'made while the clock was wrong');
  const r = sb.run(['--daily', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily')).sort(), ['2026-11-06', '2099-01-01']);
});

test('a dated folder with no backup in it is yours: never counted or deleted', () => {
  const sb = sandbox();
  const mine = path.join(sb.to, 'daily', '2026-01-01');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'my-notes.txt'), 'notes');
  const r = sb.run(['--daily', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(mine, 'my-notes.txt'), 'utf8'), 'notes');
  assert.doesNotMatch(r.stdout, /Removed/);
});

// The copy keeps the library's WAL mode. The Mac's sqlite3 can read the library, which the
// Shortcuts app keeps open, but its read-only connections won't create the -shm file that a fresh
// copy needs ("unable to open database file (14)"); this machine's sqlite3 creates it.
for (const [which, realSqlite] of [["this machine's sqlite3", true], ["a sqlite3 that acts like the Mac's", 'mac']]) {
  test(`backs up a library another program has open, changes not yet checkpointed included, without changing it (${which})`,
    { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, async () => {
      const sb = sandbox({ library: null, tools: ['shortcuts'], realSqlite });
      fs.mkdirSync(path.dirname(sb.library), { recursive: true });
      sqlite(sb.library, "PRAGMA journal_mode=WAL; CREATE TABLE ZSHORTCUT (Z_PK INTEGER PRIMARY KEY, ZNAME TEXT); INSERT INTO ZSHORTCUT (ZNAME) VALUES ('Morning'), ('Evening');");
      const holder = await holdOpen(sb.library, "PRAGMA wal_autocheckpoint=0; INSERT INTO ZSHORTCUT (ZNAME) VALUES ('Unflushed');");
      try {
        assert.ok(fs.statSync(`${sb.library}-wal`).size > 0);
        const before = crypto.createHash('sha256').update(fs.readFileSync(sb.library)).digest('hex');
        const r = sb.run([]);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sb.library)).digest('hex'), before);
        const copy = path.join(sb.dir, 'unpacked.sqlite');
        fs.writeFileSync(copy, zlib.gunzipSync(fs.readFileSync(path.join(sb.to, 'daily/2026-11-06/Shortcuts.sqlite.gz'))));
        assert.equal(sqlite(copy, 'PRAGMA quick_check;'), 'ok\n');
        assert.equal(sqlite(copy, 'SELECT ZNAME FROM ZSHORTCUT ORDER BY Z_PK;'), 'Morning\nEvening\nUnflushed\n');
        assert.deepEqual(fs.readdirSync(sb.tmp), []);
      } finally {
        await holder.close();
      }
    });
}

test("a sqlite3 startup file (~/.sqliterc) doesn't break the backup", { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, () => {
  const sb = sandbox({ library: null, tools: ['shortcuts'], realSqlite: true });
  fs.mkdirSync(path.dirname(sb.library), { recursive: true });
  sqlite(sb.library, "CREATE TABLE ZSHORTCUT (ZNAME TEXT); INSERT INTO ZSHORTCUT VALUES ('A');");
  const config = path.join(sb.dir, 'config'); // sqlite3 reads $XDG_CONFIG_HOME/sqlite3/sqliterc like ~/.sqliterc
  fs.mkdirSync(path.join(config, 'sqlite3'), { recursive: true });
  fs.writeFileSync(path.join(config, 'sqlite3', 'sqliterc'), '.headers on\n.mode column\n.echo on\n');
  const r = sb.run([], { env: { XDG_CONFIG_HOME: config } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(sb.to, 'daily/2026-11-06/Shortcuts.sqlite.gz')));
});

test('works when the temp and backup folders have spaces, quotes, backslashes, %, ?, # and a newline in their paths', // Review Focus 1
  { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, () => {
    const sb = sandbox({ library: null, tools: ['shortcuts'], realSqlite: true });
    fs.mkdirSync(path.dirname(sb.library), { recursive: true });
    sqlite(sb.library, "CREATE TABLE ZSHORTCUT (ZNAME TEXT); INSERT INTO ZSHORTCUT VALUES ('A');");
    const tmp = path.join(sb.dir, 'tmp "quoted" \'single\' \\ \\n\\101 %41 100% ?x=1&y #top new\nline dir');
    fs.mkdirSync(tmp);
    const to = path.join(sb.home, 'My "Backups"', 'Shortcuts');
    const r = sb.run(['--to', to], { tmpDir: tmp });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(to, 'daily/2026-11-06/Shortcuts.sqlite.gz')));
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

test('works when the temp folder is a relative path', { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, () => {
  const sb = sandbox({ library: null, tools: ['shortcuts'], realSqlite: true });
  fs.mkdirSync(path.dirname(sb.library), { recursive: true });
  sqlite(sb.library, "CREATE TABLE ZSHORTCUT (ZNAME TEXT); INSERT INTO ZSHORTCUT VALUES ('A');");
  const r = sb.run([], { tmpDir: path.relative(process.cwd(), sb.tmp) });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(sb.to, 'daily/2026-11-06/Shortcuts.sqlite.gz')));
});

const SCRIPT = path.join(__dirname, '..', 'scripts', 'morning', 'backup-shortcuts.js');

test('as a command: --help prints the usage and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${USAGE}\n`);
});

test('as a command: bad options exit 2 with the problem and the usage line', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--daily', '0'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `backup-shortcuts: --daily must be a whole number from 1 to 999 (got "0")\n${USAGE.split('\n')[0]}\n`);
});

test('as a command: a backup into the default folder exits 0', () => {
  const sb = sandbox();
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...sb.env, TMPDIR: sb.tmp } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Backed up 3 shortcuts \(1 KB\) to ~\/Documents\/Backups\/Shortcuts\/daily\/\d{4}-\d{2}-\d{2}$/m);
  assert.deepEqual(fs.readdirSync(sb.tmp), []);
});

// ---- Failures and tidy ----------------------------------------------------------------------

test('no library: exit 1 with the fix, and the backup folder is not touched', () => {
  const sb = sandbox({ library: null });
  const r = sb.run([]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'backup-shortcuts: no Shortcuts library at ~/Library/Shortcuts/Shortcuts.sqlite. Open the Shortcuts app once, then try again.\n');
  assert.equal(fs.existsSync(sb.to), false);
  assert.deepEqual(sb.calls('sqlite3'), []);
});

test('blocked by macOS privacy rules: the message names the node that needs Full Disk Access', () => {
  const sb = sandbox();
  const link = path.join(sb.dir, 'node-link');
  fs.symlinkSync(process.execPath, link);
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' }); };
  const r = sb.run([], { checkAccess: eperm, nodePath: link });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, [
    'backup-shortcuts: macOS blocked access to ~/Library/Shortcuts (operation not permitted).',
    'Give node Full Disk Access once: System Settings → Privacy & Security → Full Disk Access →',
    `click + → press ⌘⇧G → paste ${fs.realpathSync(process.execPath)} → press Return → Open, and make sure its switch is on.`,
    'Started it from Terminal? Then Terminal needs Full Disk Access instead.',
    'After a Homebrew upgrade of node, macOS forgets this; do it again with the new path.',
    '',
  ].join('\n'));
  assert.equal(fs.existsSync(sb.to), false);
});

test("other read errors, EACCES included, say the library can't be read", () => {
  const sb = sandbox();
  const eacces = () => { throw Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: 'EACCES' }); };
  const r = sb.run([], { checkAccess: eacces });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "backup-shortcuts: can't read ~/Library/Shortcuts/Shortcuts.sqlite: EACCES: permission denied, open 'x'\n");
});

test('sqlite3 missing, the copy failing or the check failing: exit 1, nothing replaced or removed', () => {
  const cases = [
    { opts: { tools: ['shortcuts'] }, env: {}, message: 'sqlite3 not found. It ships with macOS at /usr/bin/sqlite3; check PATH.' },
    { opts: {}, env: { FAKE_SQLITE: 'fail-copy' }, message: "sqlite3 couldn't copy the library: Error: disk I/O error" },
    {
      opts: {}, env: { FAKE_CHECK: '*** in database main ***\nPage 7: btreeInitPage() returns error code 11' },
      message: "the copy failed SQLite's integrity check (*** in database main ***). Nothing was replaced.",
    },
  ];
  for (const c of cases) {
    const sb = sandbox(c.opts);
    seedBackups(sb.to);
    const before = tree(sb.to);
    const r = sb.run(['--daily', '1', '--weekly', '1', '--monthly', '1'], { env: c.env });
    assert.equal(r.code, 1, c.message);
    assert.equal(r.stderr, `backup-shortcuts: ${c.message}\n`);
    assert.deepEqual(tree(sb.to), before);
    assert.deepEqual(fs.readdirSync(sb.tmp), []);
  }
});

test("a backup folder that can't be created: exit 1 naming the folder and the error", () => {
  const sb = sandbox();
  const file = path.join(sb.dir, 'a-file');
  fs.writeFileSync(file, '');
  const to = path.join(file, 'Shortcuts');
  const r = sb.run(['--to', to]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.startsWith(`backup-shortcuts: can't write to ${to}: ENOTDIR`), r.stderr);
  assert.deepEqual(fs.readdirSync(sb.tmp), []);
});

test("a failure after today's backup is saved removes nothing", () => {
  const sb = sandbox();
  seedBackups(sb.to);
  fs.writeFileSync(path.join(sb.to, 'weekly', '2026-11-06'), 'a file in the way'); // the weekly rename fails
  const r = sb.run(['--daily', '1']);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.startsWith("backup-shortcuts: can't write to ~/Documents/Backups/Shortcuts: "), r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily')).sort(), ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'weekly')).sort(), ['2026-10-26', '2026-11-06']); // no .incoming-* left
});

test("if replacing today's backup fails, today's earlier backup is put back", () => {
  const sb = sandbox();
  sb.run([]);
  fs.writeFileSync(sb.library, 'library v2');
  const today = path.join(sb.to, 'daily', '2026-11-06');
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { // only the new backup's move into place fails
    if (to === today && path.basename(from).startsWith('.incoming-')) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    return realRename(from, to);
  };
  let r;
  try {
    r = sb.run([], { now: new Date(2026, 10, 6, 9, 30) });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(r.code, 1);
  assert.ok(r.stderr.startsWith("backup-shortcuts: can't write to ~/Documents/Backups/Shortcuts: EIO"), r.stderr);
  assert.equal(gunzip(path.join(today, 'Shortcuts.sqlite.gz')), 'library v1');
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily')), ['2026-11-06']); // no .replaced-* or .incoming-* left
});

test('shortcuts list failing only warns: the backup is saved without the names file', () => {
  const sb = sandbox();
  const r = sb.run([], { env: { FAKE_SHORTCUTS: 'fail' } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "backup-shortcuts: warning: couldn't list shortcut names (Error: The operation couldn’t be completed.); the backup is saved without shortcut-names.txt\n");
  assert.match(r.stdout, /^Backed up your Shortcuts library \(1 KB\) to ~\/Documents\/Backups\/Shortcuts\/daily\/2026-11-06$/m);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily/2026-11-06')), ['Shortcuts.sqlite.gz']);
});

test('shortcuts list hanging only warns, once its time limit passes', () => { // Review Focus 5
  const sb = sandbox();
  const r = sb.run([], { env: { FAKE_SHORTCUTS: 'hang' }, timeouts: { copy: 300000, names: 500 } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "backup-shortcuts: warning: couldn't list shortcut names (timed out); the backup is saved without shortcut-names.txt\n");
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily/2026-11-06')), ['Shortcuts.sqlite.gz']);
});

test('leftovers from a crashed run are removed after an hour; recent ones are kept', () => {
  const sb = sandbox();
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  for (const p of ['daily/.incoming-old', 'weekly/.replaced-old', 'monthly/.incoming-old']) {
    fs.mkdirSync(path.join(sb.to, p), { recursive: true });
    fs.utimesSync(path.join(sb.to, p), old, old);
  }
  fs.mkdirSync(path.join(sb.to, 'daily/.incoming-recent'));
  assert.equal(sb.run([]).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily')).sort(), ['.incoming-recent', '2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'weekly')), ['2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'monthly')), ['2026-11-06']);
});
