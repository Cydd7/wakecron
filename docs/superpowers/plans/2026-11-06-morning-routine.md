# Morning Routine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `scripts/morning.sh`, a wakecron routine that runs every day at 07:00. Its first step
backs up the Apple Shortcuts library, keeping daily, weekly and monthly copies.

**Architecture:**
- A bash routine runs its `step` lines in order and exits 1 if any step failed.
- The backup step is one self-contained Node script. It has two parts:
  - pure rules: dates, rotation, options and output text;
  - a run that copies the library with `sqlite3 -readonly … .backup`, checks the copy, gzips it
    into dated folders, then promotes and prunes.
- Tests run the step in the same process, through an injectable context and stand-in tools. One
  test uses a real `sqlite3`.

**Tech Stack:**
- bash;
- Node.js ≥ 20, using only its built-in modules (`fs`, `os`, `path`, `zlib`, `crypto`,
  `child_process`);
- `node:test` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-11-06-morning-routine-design.md`

## Global Constraints

- **Language and dependencies.** Node.js 20 or newer. CommonJS with `'use strict'`. No npm
  dependencies, only `node:` built-in modules.
- **Scope.** `scripts/morning/backup-shortcuts.js` doesn't `require` anything from wakecron's
  `lib/`. No file in `lib/` changes, and neither does the `wakecron` entry point.
- **Library.** The library is `<HOME>/Library/Shortcuts/Shortcuts.sqlite`, where HOME is
  `ctx.env.HOME`, or `os.homedir()` when that is unset. It is opened read-only and never written.
- **Defaults.**
  - The backup folder is `~/Documents/Backups/Shortcuts`.
  - The counts are `--daily 7`, `--weekly 4` and `--monthly 12`.
  - Each count is a whole number from 1 to 999.
- **Commands.** Tools are found on `PATH`.
  - The copy is `sqlite3 -readonly -cmd ".timeout 10000" <library> ".backup <temp>/Shortcuts.sqlite"`.
  - The check is `sqlite3 -readonly <copy> "PRAGMA quick_check;"`. It must print exactly `ok`.
  - The copy and the check each have a 5-minute limit.
  - The names come from `shortcuts list`, with a 60-second limit.
- **Names on disk.**
  - Files: `Shortcuts.sqlite.gz` and `shortcut-names.txt`.
  - Kind folders: `daily/`, `weekly/` and `monthly/`, each holding `YYYY-MM-DD` folders.
  - Staging folders: `.incoming-*` and `.replaced-*`.
- **Permissions.** Folders the step creates are mode 0700, and files are mode 0600.
- **Dates.** Dates are local calendar dates. Weeks run Monday to Sunday.
- **Errors.**
  - Errors are printed to stderr as `backup-shortcuts: <message>`, and the step exits 1.
  - Usage errors exit 2.
  - Warnings start with `backup-shortcuts: warning:`.
  - Messages are the spec's §6 text, word for word.
- **Tests.** Use `node:test` and pass on Linux and macOS. Tests that need a real `sqlite3` skip
  with the reason `sqlite3 is not installed` when it's missing.
- **Commits.** Every commit message ends with the session's attribution trailer.

## Review Focus

1. **Odd paths.** The temporary folder and the backup folder may contain spaces, double quotes or
   backslashes. The backup must still work, because sqlite3 has to receive the quoted path
   intact. The test is in Task 3, with real sqlite3.
2. **Odd shortcut names.** Names may contain emoji or accents, start with spaces, or repeat. They
   must be kept exactly, sorted without regard to case, and counted. The test is in Task 2.
3. **A second run on the same day.** It replaces that day's backup, but this week's and this
   month's copies keep the first run's content. The test is in Task 3.
4. **Things the user put in the backup folder.** Examples: a top-level `before-restore-…`
   folder, `daily/notes`, `daily/2026-11-01-old`, and a regular file named `daily/2026-10-01`. They
   are never counted and never deleted. The test is in Task 3.
5. **`shortcuts list` hanging after wake.** The run warns once the time limit passes, and the
   backup is still saved. The limit is injectable so the test is fast. The test is in Task 4.

## Files

| File | Responsibility |
|---|---|
| `scripts/morning/backup-shortcuts.js` (create, mode 755) | The whole backup step: pure rules (Tasks 1–2), the run (Task 3), failures and tidy (Task 4) |
| `tests/backup-shortcuts.test.js` (create) | Tests for everything in that file, plus sandbox helpers |
| `tests/fakes/backup-tools.js` (create) | Stand-in `sqlite3` and `shortcuts`. Each sandbox writes `bin/` wrappers that exec it. |
| `scripts/morning.sh` (create, mode 755) | The routine (Task 5) |
| `tests/morning.test.js` (create) | Tests for the routine (Task 5) |
| `README.md` (modify) | A pointer under the intro, a "Morning routine" section after "Writing scripts", and one line under "Development" (Task 5) |

---

### Task 1: Dates and rotation rules

**Files:**
- Create: `scripts/morning/backup-shortcuts.js`. It starts with `#!/usr/bin/env node`, then
  `'use strict';`, then a two-line header comment naming the spec. Give it mode 755.
- Create: `tests/backup-shortcuts.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, through `module.exports`, which later tasks extend:
  - `localDate(date: Date): string` returns the local calendar date as `YYYY-MM-DD`.
  - `mondayOf(day: string): string` returns the Monday on or before the `YYYY-MM-DD` day.
  - `planRotation({ today, existing, keep })` returns
    `{ replaceDaily: boolean, weekly: boolean, monthly: boolean, prune: { daily: string[], weekly: string[], monthly: string[] } }`.
    - `today` is a string.
    - `existing` is `{ daily, weekly, monthly }`, each a `string[]` of folder names as found.
    - `keep` is `{ daily, weekly, monthly }`, each a number.
    - Each `prune` list is sorted oldest first.

- [ ] **Step 1: Write the failing tests** in `tests/backup-shortcuts.test.js`. Start with
  `node:test`, `node:assert/strict`, and
  `const { localDate, mondayOf, planRotation } = require('../scripts/morning/backup-shortcuts');`.

```js
const KEEP = { daily: 7, weekly: 4, monthly: 12 };
const none = { daily: [], weekly: [], monthly: [] };
const withTZ = (tz, fn) => { const old = process.env.TZ; process.env.TZ = tz; try { return fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; } };

test('localDate is the local calendar date', () => {
  assert.equal(localDate(new Date(2026, 10, 6, 7, 0)), '2026-11-06');
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  withTZ('America/New_York', () => {
    assert.equal(localDate(new Date('2026-11-01T04:30:00Z')), '2026-11-01'); // the night US DST ends
    assert.equal(localDate(new Date('2026-11-01T03:30:00Z')), '2026-10-31');
  });
});

test('mondayOf finds the Monday that starts the week, in any time zone', () => {
  for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney']) withTZ(tz, () => {
    assert.equal(mondayOf('2026-11-06'), '2026-11-02'); // Friday
    assert.equal(mondayOf('2026-11-02'), '2026-11-02'); // Monday
    assert.equal(mondayOf('2026-11-08'), '2026-11-02'); // Sunday
    assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // US DST ends
    assert.equal(mondayOf('2026-10-25'), '2026-10-19'); // EU DST ends
    assert.equal(mondayOf('2027-01-01'), '2026-12-28');
  });
});

test('the first run ever makes a daily, a weekly and a monthly backup', () => {
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: none, keep: KEEP }),
    { replaceDaily: false, weekly: true, monthly: true, prune: { daily: [], weekly: [], monthly: [] } });
});

test('later days in the same week and month make only a daily backup', () => {
  const existing = { daily: ['2026-11-06'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  const plan = planRotation({ today: '2026-11-08', existing, keep: KEEP });
  assert.equal(plan.replaceDaily, false); assert.equal(plan.weekly, false); assert.equal(plan.monthly, false);
});

test('Monday starts a new week', () => {
  const existing = { daily: ['2026-11-08'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  assert.equal(planRotation({ today: '2026-11-09', existing, keep: KEEP }).weekly, true);
});

test("a new month gets a monthly backup; the week keeps its earlier weekly", () => {
  const existing = { daily: ['2026-11-30'], weekly: ['2026-11-30'], monthly: ['2026-11-06'] };
  const plan = planRotation({ today: '2026-12-01', existing, keep: KEEP });
  assert.equal(plan.monthly, true); assert.equal(plan.weekly, false);
});

test('a week that spans New Year is one week', () => {
  const existing = { daily: ['2026-12-31'], weekly: ['2026-12-28'], monthly: ['2026-12-01'] };
  const plan = planRotation({ today: '2027-01-01', existing, keep: KEEP });
  assert.equal(plan.weekly, false); assert.equal(plan.monthly, true);
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
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: { ...none, daily }, keep: { ...KEEP, daily: 1 } }).prune.daily, ['2026-11-01', '2026-11-02']);
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
```

- [ ] **Step 2: Run the tests and watch them fail.**
  Run `node --test tests/backup-shortcuts.test.js`. Expect FAIL with
  `Cannot find module '../scripts/morning/backup-shortcuts'`.

- [ ] **Step 3: Implement** in `scripts/morning/backup-shortcuts.js`.
  - Add the constants `KINDS = ['daily', 'weekly', 'monthly']` and `DATED = /^\d{4}-\d{2}-\d{2}$/`.
  - `localDate` uses the local getters, zero-padded.
  - `mondayOf` and an internal `addDays(day, n)` do their arithmetic on `Date.UTC` dates, so time
    zones and DST can't move them. A day goes back `(getUTCDay() + 6) % 7` days to reach Monday.
  - `planRotation` follows these rules:
    - Only names matching `DATED` count.
    - `replaceDaily` is true when today is among the existing daily dates.
    - `weekly` is true when no existing weekly date d satisfies
      `mondayOf(today) ≤ d ≤ addDays(mondayOf(today), 6)`.
    - `monthly` is true when no existing monthly date starts with `today.slice(0, 7)`.
    - For each kind, take the dates this run leaves behind: the existing dated ones, plus today
      for daily (always) and for weekly or monthly (when promoted), without duplicates. Sort them
      newest first. Everything after the first `keep[kind]` is pruned. Return the pruned dates
      sorted ascending.

- [ ] **Step 4: Run the tests and watch them pass.**
  Run `node --test tests/backup-shortcuts.test.js`. Expect all tests to pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/morning/backup-shortcuts.js tests/backup-shortcuts.test.js
git commit -m "feat: rotation rules for Shortcuts backups"   # plus the trailer
```

---

### Task 2: Options and output text

**Files:**
- Modify: `scripts/morning/backup-shortcuts.js`
- Test: `tests/backup-shortcuts.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `USAGE: string` holds the exact text below. Its first line is the usage line that errors print.
  - `class UsageError extends Error`, with `name = 'UsageError'`.
  - `parseOptions(argv: string[], home: string, cwd = process.cwd())` returns
    `{ help: boolean, to: string, keep: { daily: number, weekly: number, monthly: number } }`.
    `to` is absolute. It throws `UsageError`.
  - `parseNames(text: string): string[]`
  - `formatSize(bytes: number): string`
  - `tildePath(p: string, home: string): string`
  - `summaryLines({ count, size, folder, replaced, weekly, monthly, removed }): string[]`, where
    - `count` is `number | null`;
    - `size` and `folder` are strings;
    - `replaced`, `weekly` and `monthly` are booleans;
    - `removed` is a `string[]` of `kind/date` entries.

`USAGE`, exactly:

```
usage: node morning/backup-shortcuts.js [--to DIR] [--daily N] [--weekly N] [--monthly N]
Backs up all your Apple Shortcuts into DIR/daily, DIR/weekly and DIR/monthly.
  --to DIR      backup folder (default: ~/Documents/Backups/Shortcuts)
  --daily N     daily backups to keep (default: 7)
  --weekly N    weekly backups to keep (default: 4)
  --monthly N   monthly backups to keep (default: 12)
```

- [ ] **Step 1: Write the failing tests.**

```js
const HOME = '/Users/me';

test('options default to the Documents folder and 7/4/12', () => {
  assert.deepEqual(parseOptions([], HOME), { help: false, to: '/Users/me/Documents/Backups/Shortcuts', keep: { daily: 7, weekly: 4, monthly: 12 } });
});

test('options take "--name value" and "--name=value"; a leading ~ is home; relative is from cwd', () => {
  assert.deepEqual(parseOptions(['--to', '/x/y', '--daily', '3', '--weekly=2', '--monthly', '24'], HOME), { help: false, to: '/x/y', keep: { daily: 3, weekly: 2, monthly: 24 } });
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
  assert.ok(names.includes('  Indented')); assert.ok(names.includes('🌅 Sunrise'));
  assert.deepEqual(names.filter((n) => /^[A-Za-zÉ]/.test(n)), ['Alpha', 'Alpha', 'beta', 'Echo', 'École', 'zeta']);
  assert.deepEqual(parseNames(''), []);
});

test('sizes use decimal units like Finder', () => {
  assert.equal(formatSize(400), '1 KB'); assert.equal(formatSize(1499), '1 KB'); assert.equal(formatSize(1500), '2 KB');
  assert.equal(formatSize(999_499), '999 KB'); assert.equal(formatSize(999_500), '1.0 MB');
  assert.equal(formatSize(1_449_999), '1.4 MB'); assert.equal(formatSize(12_345_678), '12.3 MB');
});

test('paths under home are shown with ~', () => {
  assert.equal(tildePath('/Users/me/Documents/x', HOME), '~/Documents/x');
  assert.equal(tildePath('/Users/me', HOME), '~');
  assert.equal(tildePath('/Users/meme/x', HOME), '/Users/meme/x');
  assert.equal(tildePath('/Volumes/B', HOME), '/Volumes/B');
});

test('the summary reports what was backed up, promoted and removed', () => {
  const base = { count: 87, size: '1.4 MB', folder: '~/Documents/Backups/Shortcuts/daily/2026-11-06', replaced: false, weekly: true, monthly: true, removed: ['daily/2026-10-30'] };
  assert.deepEqual(summaryLines(base), [
    'Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06',
    "Also this week's and this month's backup.",
    'Removed 1 old backup: daily/2026-10-30',
  ]);
  assert.equal(summaryLines({ ...base, count: 1 })[0], 'Backed up 1 shortcut (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06');
  assert.equal(summaryLines({ ...base, count: null })[0], 'Backed up your Shortcuts library (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06');
  assert.equal(summaryLines({ ...base, replaced: true })[0], "Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06 (replaced today's earlier backup)");
  assert.equal(summaryLines({ ...base, monthly: false })[1], "Also this week's backup.");
  assert.equal(summaryLines({ ...base, weekly: false })[1], "Also this month's backup.");
  assert.deepEqual(summaryLines({ ...base, weekly: false, monthly: false, removed: [] }), ['Backed up 87 shortcuts (1.4 MB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06']);
  assert.equal(summaryLines({ ...base, removed: ['daily/2026-10-29', 'weekly/2026-10-05'] })[2], 'Removed 2 old backups: daily/2026-10-29, weekly/2026-10-05');
});
```

- [ ] **Step 2: Run the tests and watch them fail.**
  Run `node --test tests/backup-shortcuts.test.js`. Expect FAIL with
  `parseOptions is not a function`, and the same for the other new exports.

- [ ] **Step 3: Implement** the exports.
  - `parseOptions` is a small loop over argv. It doesn't use `util.parseArgs`, because the error
    messages must be exactly the ones the tests pin.
    - It accepts `-h`, `--help`, `--to`, `--daily`, `--weekly` and `--monthly`, in the `--name value`
      or `--name=value` form.
    - Any other argument that starts with `-` is an unknown option. Anything else is an unexpected
      argument.
    - Counts must match `/^\d+$/` and fall in 1–999.
    - For `to`, expand a leading `~` or `~/`, then `path.resolve(cwd, value)`.
  - `parseNames` keeps the non-blank lines exactly as they are. It sorts them with
    `a.localeCompare(b, 'en', { sensitivity: 'base' })`, breaking ties by code-point order.
  - `formatSize`: if `kb = Math.round(bytes / 1000)` is below 1000, return
    `${Math.max(1, kb)} KB`. Otherwise return `${(bytes / 1e6).toFixed(1)} MB`.

- [ ] **Step 4: Run the tests and watch them pass.**
  Run `node --test tests/backup-shortcuts.test.js`. Expect all tests to pass.

- [ ] **Step 5: Commit** with the message `feat: options and summary text for Shortcuts backups`.

---

### Task 3: The backup run

**Files:**
- Modify: `scripts/morning/backup-shortcuts.js`
- Create: `tests/fakes/backup-tools.js`
- Test: `tests/backup-shortcuts.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces:
  - `main(argv: string[], ctx = {}): number`, returning the exit code. `ctx` defaults:
    - `env = process.env`
    - `now = () => new Date()`
    - `stdout = process.stdout` and `stderr = process.stderr`. Only `.write(string)` is used.
    - `checkAccess = (file) => fs.closeSync(fs.openSync(file, 'r'))`
    - `nodePath = process.execPath`
    - `tmpDir = os.tmpdir()`
    - `timeouts = { copy: 300000, names: 60000 }`
  - `if (require.main === module) process.exitCode = main(process.argv.slice(2));`
  - The test helpers below, which Task 4 reuses.

**Stand-in tools.** `tests/fakes/backup-tools.js` runs as `node backup-tools.js <tool> …args`.
Every call appends `JSON.stringify([tool, ...args])` and a newline to `$FAKE_LOG`.

- `sqlite3`:
  - An argument starting with `.backup ` is a copy request.
    - With `FAKE_SQLITE=fail-copy` set, it prints `Error: disk I/O error` to stderr and exits 1.
    - Otherwise it unescapes the double-quoted destination (`\\` becomes `\`, `\"` becomes `"`),
      copies the argument before it (the library) there, and exits 0.
  - An argument equal to `PRAGMA quick_check;` makes it print `${FAKE_CHECK ?? 'ok'}` and a
    newline, then exit 0.
  - Anything else exits 64.
- `shortcuts list`:
  - With `FAKE_SHORTCUTS=fail`, it prints `Error: The operation couldn’t be completed.` to stderr
    and exits 1.
  - With `FAKE_SHORTCUTS=hang`, it never exits (it uses `setInterval`).
  - Otherwise it prints `FAKE_NAMES` (default empty) and exits 0.

**Test helpers** live at the top of `tests/backup-shortcuts.test.js`.

- `FRI_7AM = new Date(2026, 10, 6, 7, 0)`
- `NAMES = 'Morning Weather\nbackup notes\nZoom Link\n'`
- `HAS_SQLITE` is `spawnSync('sqlite3', ['-version']).status === 0`. Put the directory of the
  real sqlite3 (from `command -v sqlite3`) in `SQLITE_DIR`.
- `sandbox({ library = 'library v1', tools = ['sqlite3', 'shortcuts'], realSqlite = false } = {})`:
  - It makes a real-pathed temporary folder that is removed when the process exits.
  - Inside are `home/`, `bin/` and `tmp/`. When `library` is a string, it is written to
    `home/Library/Shortcuts/Shortcuts.sqlite`.
  - `bin/<tool>` wrappers read `#!/bin/sh` then `exec "<node>" "<repo>/tests/fakes/backup-tools.js" <tool> "$@"`.
  - It returns:
    - `{ dir, home, bin, tmp, to, library, log }`, where
      `to = home/Documents/Backups/Shortcuts`;
    - `env = { PATH: bin (+ ':' + SQLITE_DIR when realSqlite), HOME: home, FAKE_LOG: log, FAKE_NAMES: NAMES }`;
    - `run(argv = [], { env = {}, now = FRI_7AM, ...rest } = {})`, which calls
      `main(argv, { env: { ...sb.env, ...env }, now: () => now, stdout, stderr, tmpDir: tmp, ...rest })`
      with capturing streams and returns `{ code, stdout, stderr }`;
    - `calls(tool)`, which returns the argument arrays logged for that tool, or `[]` when nothing
      was logged.
- `gunzip(file)` returns the gunzipped text.
- `tree(root)` maps each relative path below `root` to `'dir'` or to the file's contents, and
  returns `{}` when `root` is missing.
- `sqlite(db, sql)` runs the real `sqlite3 db sql`, asserts it exits 0 and returns stdout.
- `holdOpen(db, sql)` spawns the real `sqlite3 db` with a piped stdin and writes `sql`. It then
  polls `sqlite3 -readonly db "SELECT count(*) FROM ZSHORTCUT;"` every 50 ms, for up to 5 s,
  until it prints `3`. It resolves to `{ close() }`, which ends stdin and waits for the process
  to exit.

- [ ] **Step 1: Install a real sqlite3 for development.**
  Run `apt-get install -y sqlite3 || (apt-get update && apt-get install -y sqlite3)`, then
  `sqlite3 -version`. It should print a version.
  If it can't be installed, carry on: the real-sqlite3 tests will report SKIP, and you note that in
  the ledger.

- [ ] **Step 2: Write `tests/fakes/backup-tools.js` and the helpers**, as specified above.

- [ ] **Step 3: Write the failing tests.** Import `main` and `USAGE` from the step. Also import
  `node:fs`, `node:os`, `node:path`, `node:zlib`, `node:crypto` and `spawn`/`spawnSync` from
  `node:child_process`.

```js
test('the first run backs up the library into daily, weekly and monthly', () => {
  const sb = sandbox(); const r = sb.run([]);
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stderr, '');
  assert.equal(r.stdout, "Backed up 3 shortcuts (1 KB) to ~/Documents/Backups/Shortcuts/daily/2026-11-06\nAlso this week's and this month's backup.\n");
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const dir = path.join(sb.to, kind, '2026-11-06');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Shortcuts.sqlite.gz', 'shortcut-names.txt']);
    assert.equal(gunzip(path.join(dir, 'Shortcuts.sqlite.gz')), 'library v1');
    assert.equal(fs.readFileSync(path.join(dir, 'shortcut-names.txt'), 'utf8'), 'backup notes\nMorning Weather\nZoom Link\n');
  }
});

test('backups are private: folders 0700, files 0600', () => {
  const sb = sandbox(); sb.run([]);
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(sb.to), 0o700);
  for (const kind of ['daily', 'weekly', 'monthly']) {
    assert.equal(mode(path.join(sb.to, kind)), 0o700); assert.equal(mode(path.join(sb.to, kind, '2026-11-06')), 0o700);
    for (const f of ['Shortcuts.sqlite.gz', 'shortcut-names.txt']) assert.equal(mode(path.join(sb.to, kind, '2026-11-06', f)), 0o600);
  }
});

test('sqlite3 copies the library read-only with a busy timeout, then checks the copy', () => {
  const sb = sandbox(); sb.run([]);
  const [copy, check] = sb.calls('sqlite3');
  assert.deepEqual(copy.slice(0, 4), ['-readonly', '-cmd', '.timeout 10000', sb.library]);
  assert.ok(copy[4].startsWith(`.backup "${sb.tmp}/backup-shortcuts-`), copy[4]);
  assert.ok(copy[4].endsWith('/Shortcuts.sqlite"'), copy[4]);
  assert.deepEqual(check, ['-readonly', copy[4].slice(9, -1), 'PRAGMA quick_check;']);
  assert.deepEqual(sb.calls('shortcuts'), [['list']]);
  assert.deepEqual(fs.readdirSync(sb.tmp), []); // the temporary copy is gone
});

test('a later day in the same week makes only a daily backup', () => {
  const sb = sandbox(); sb.run([]);
  const r = sb.run([], { now: new Date(2026, 10, 7, 7, 0) });
  assert.equal(r.stdout, 'Backed up 3 shortcuts (1 KB) to ~/Documents/Backups/Shortcuts/daily/2026-11-07\n');
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'weekly')), ['2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'monthly')), ['2026-11-06']);
});

test("a second run the same day replaces that day's backup; this week's and month's keep the first", () => { // Review Focus 3
  const sb = sandbox(); sb.run([]);
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
  const sb = sandbox(); const daily = path.join(sb.to, 'daily');
  for (const d of ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) fs.mkdirSync(path.join(daily, d), { recursive: true });
  fs.mkdirSync(path.join(daily, 'notes')); fs.mkdirSync(path.join(daily, '2026-11-01-old'));
  fs.writeFileSync(path.join(daily, '2026-10-01'), 'a file, not a backup');
  fs.mkdirSync(path.join(sb.to, 'before-restore-20261101-120000'));
  const r = sb.run([]);
  assert.match(r.stdout, /^Removed 2 old backups: daily\/2026-10-29, daily\/2026-10-30$/m);
  assert.deepEqual(fs.readdirSync(daily).sort(), ['2026-10-01', '2026-10-31', '2026-11-01', '2026-11-01-old', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', 'notes']);
  assert.ok(fs.existsSync(path.join(sb.to, 'before-restore-20261101-120000')));
});

test('backs up a library another program has open, changes not yet checkpointed included, without writing to it',
  { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, async () => {
    const sb = sandbox({ library: null, tools: ['shortcuts'], realSqlite: true });
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
    } finally { await holder.close(); }
  });

test('works when the temp and backup folders have spaces, quotes and a backslash in their paths', // Review Focus 1
  { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, () => {
    const sb = sandbox({ library: null, tools: ['shortcuts'], realSqlite: true });
    fs.mkdirSync(path.dirname(sb.library), { recursive: true });
    sqlite(sb.library, "CREATE TABLE ZSHORTCUT (ZNAME TEXT); INSERT INTO ZSHORTCUT VALUES ('A');");
    const tmp = path.join(sb.dir, 'tmp "quoted" \\ dir'); fs.mkdirSync(tmp);
    const to = path.join(sb.home, 'My "Backups"', 'Shortcuts');
    const r = sb.run(['--to', to], { tmpDir: tmp });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(to, 'daily/2026-11-06/Shortcuts.sqlite.gz')));
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

const SCRIPT = path.join(__dirname, '..', 'scripts', 'morning', 'backup-shortcuts.js');

test('as a command: --help prints the usage and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(r.stdout, `${USAGE}\n`);
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
```

- [ ] **Step 4: Run the tests and watch them fail.**
  Run `node --test tests/backup-shortcuts.test.js`. The new tests should FAIL with
  `main is not a function`, and the `--help` test should fail on its exit code. The Task 1–2
  tests still pass.

- [ ] **Step 5: Implement `main` and the run**, following spec §5.2 steps 1 and 3–9.
  - **Running tools.** Use
    `spawnSync(tool, args, { env: ctx.env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 })`.
  - **The copy.** Its last argument is `` `.backup "${dest.replace(/[\\"]/g, '\\$&')}"` ``, where
    `dest` is `<temp>/Shortcuts.sqlite`. The temporary folder is
    `fs.mkdtempSync(path.join(ctx.tmpDir, 'backup-shortcuts-'))`. Remove it in a `finally`.
  - **Names.** When `shortcuts list` exits 0, use `parseNames(stdout)`. Task 4 covers the other
    cases; for now, anything else means `null`.
  - **Folder names.** Read the existing names in `daily/`, `weekly/` and `monthly/` before saving,
    as directories only (`withFileTypes`). A missing folder counts as empty. Pass them to
    `planRotation`.
  - **Saving today's backup.**
    - Create the kind folders with `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`.
    - Stage in `fs.mkdtempSync(path.join(to, 'daily', '.incoming-'))`.
    - Write `Shortcuts.sqlite.gz` as `zlib.gzipSync` of the copy.
    - When `names` isn't null, write `shortcut-names.txt` as `names.join('\n')`, plus a trailing
      `\n` when there are any names.
    - Write both files with `{ mode: 0o600 }`.
    - To replace an earlier backup from today, rename it to
      `daily/.replaced-<crypto.randomBytes(4) hex>`, rename the staged folder into place, then
      `fs.rmSync` the replaced one.
  - **Promoting.** Copy each file of `daily/<today>` into `<kind>/.incoming-*` with
    `fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE)`. Then rename that folder to
    `<kind>/<today>`.
  - **Pruning.** `fs.rmSync(path.join(to, kind, date), { recursive: true, force: true })`.
  - **The summary.**
    - `count` is `names ? names.length : null`.
    - `size` is the `formatSize` of the `.gz` file.
    - `folder` is the `tildePath` of `daily/<today>`.
    - `removed` lists `kind/date`, in kind order (daily, weekly, monthly) and oldest first within
      each kind.
    - Write each line, followed by `\n`, to `ctx.stdout`.
  - **Exits.**
    - A `UsageError` writes `backup-shortcuts: <message>\n<first USAGE line>\n` to stderr and
      returns 2.
    - `--help` writes `USAGE + '\n'` to stdout and returns 0.
    - Any other error writes `backup-shortcuts: unexpected error: <message>\n` and returns 1.

- [ ] **Step 6: Run the tests and watch them pass.**
  Run `node --test tests/backup-shortcuts.test.js`. Everything passes. With sqlite3 installed,
  nothing is skipped.

- [ ] **Step 7: Run the full suite.**
  Run `npm test`. All wakecron tests still pass, along with the new ones.

- [ ] **Step 8: Commit** `scripts/morning/backup-shortcuts.js`, `tests/backup-shortcuts.test.js` and
  `tests/fakes/backup-tools.js` with the message `feat: back up the Shortcuts library into daily, weekly and monthly copies`.

---

### Task 4: Failures and tidy

**Files:**
- Modify: `scripts/morning/backup-shortcuts.js`
- Test: `tests/backup-shortcuts.test.js`

**Interfaces:**
- Consumes: from Task 3, `main` with its `ctx`, plus the helpers `sandbox`, `tree` and `FRI_7AM`.
- Produces: an internal `class Failure extends Error`. `main` writes `backup-shortcuts: <message>\n`
  for it and returns 1. Add this helper:
  `seedBackups(to)` creates `daily/2026-10-31` … `daily/2026-11-04` (five days),
  `weekly/2026-10-26` and `monthly/2026-10-01`. Each one holds `old.txt`, which contains its own
  relative path.

- [ ] **Step 1: Write the failing tests.**

```js
test('no library: exit 1 with the fix, and the backup folder is not touched', () => {
  const sb = sandbox({ library: null }); const r = sb.run([]);
  assert.equal(r.code, 1); assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'backup-shortcuts: no Shortcuts library at ~/Library/Shortcuts/Shortcuts.sqlite. Open the Shortcuts app once, then try again.\n');
  assert.equal(fs.existsSync(sb.to), false); assert.deepEqual(sb.calls('sqlite3'), []);
});

test('blocked by macOS privacy rules: the message names the node that needs Full Disk Access', () => {
  const sb = sandbox(); const link = path.join(sb.dir, 'node-link'); fs.symlinkSync(process.execPath, link);
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' }); };
  const r = sb.run([], { checkAccess: eperm, nodePath: link });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, [
    'backup-shortcuts: macOS blocked access to ~/Library/Shortcuts (operation not permitted).',
    'Give node Full Disk Access once: System Settings → Privacy & Security → Full Disk Access →',
    `click + → press ⌘⇧G → paste ${fs.realpathSync(process.execPath)} → Open, and make sure its switch is on.`,
    'Started it from Terminal? Then Terminal needs Full Disk Access instead.',
    'After a Homebrew upgrade of node, macOS forgets this; do it again with the new path.',
    '',
  ].join('\n'));
  assert.equal(fs.existsSync(sb.to), false);
});

test("other read errors, EACCES included, say the library can't be read", () => {
  const sb = sandbox();
  const r = sb.run([], { checkAccess: () => { throw Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: 'EACCES' }); } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "backup-shortcuts: can't read ~/Library/Shortcuts/Shortcuts.sqlite: EACCES: permission denied, open 'x'\n");
});

test('sqlite3 missing, the copy failing or the check failing: exit 1, nothing replaced or removed', () => {
  const cases = [
    { opts: { tools: ['shortcuts'] }, env: {}, message: 'sqlite3 not found. It ships with macOS at /usr/bin/sqlite3; check PATH.' },
    { opts: {}, env: { FAKE_SQLITE: 'fail-copy' }, message: "sqlite3 couldn't copy the library: Error: disk I/O error" },
    { opts: {}, env: { FAKE_CHECK: '*** in database main ***\nPage 7: btreeInitPage() returns error code 11' },
      message: "the copy failed SQLite's integrity check (*** in database main ***). Nothing was replaced." },
  ];
  for (const c of cases) {
    const sb = sandbox(c.opts); seedBackups(sb.to); const before = tree(sb.to);
    const r = sb.run(['--daily', '1', '--weekly', '1', '--monthly', '1'], { env: c.env });
    assert.equal(r.code, 1, c.message); assert.equal(r.stderr, `backup-shortcuts: ${c.message}\n`);
    assert.deepEqual(tree(sb.to), before); assert.deepEqual(fs.readdirSync(sb.tmp), []);
  }
});

test("a backup folder that can't be created: exit 1 naming the folder and the error", () => {
  const sb = sandbox(); const file = path.join(sb.dir, 'a-file'); fs.writeFileSync(file, '');
  const to = path.join(file, 'Shortcuts'); const r = sb.run(['--to', to]);
  assert.equal(r.code, 1); assert.ok(r.stderr.startsWith(`backup-shortcuts: can't write to ${to}: ENOTDIR`), r.stderr);
  assert.deepEqual(fs.readdirSync(sb.tmp), []);
});

test("a failure after today's backup is saved removes nothing", () => {
  const sb = sandbox(); seedBackups(sb.to);
  fs.writeFileSync(path.join(sb.to, 'weekly', '2026-11-06'), 'a file in the way'); // the weekly rename fails
  const r = sb.run(['--daily', '1']);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.startsWith("backup-shortcuts: can't write to ~/Documents/Backups/Shortcuts: "), r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily')).sort(), ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'weekly')).sort(), ['2026-10-26', '2026-11-06']); // no .incoming-* left
});

test('shortcuts list failing only warns: the backup is saved without the names file', () => {
  const sb = sandbox(); const r = sb.run([], { env: { FAKE_SHORTCUTS: 'fail' } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "backup-shortcuts: warning: couldn't list shortcut names (Error: The operation couldn’t be completed.); the backup is saved without shortcut-names.txt\n");
  assert.match(r.stdout, /^Backed up your Shortcuts library \(1 KB\) to ~\/Documents\/Backups\/Shortcuts\/daily\/2026-11-06$/m);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily/2026-11-06')), ['Shortcuts.sqlite.gz']);
});

test('shortcuts list hanging only warns, once its time limit passes', () => { // Review Focus 5
  const sb = sandbox(); const r = sb.run([], { env: { FAKE_SHORTCUTS: 'hang' }, timeouts: { copy: 300000, names: 500 } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "backup-shortcuts: warning: couldn't list shortcut names (timed out); the backup is saved without shortcut-names.txt\n");
});

test('leftovers from a crashed run are removed after an hour; recent ones are kept', () => {
  const sb = sandbox(); const old = new Date(Date.now() - 2 * 3600 * 1000);
  for (const p of ['daily/.incoming-old', 'weekly/.replaced-old', 'monthly/.incoming-old']) {
    fs.mkdirSync(path.join(sb.to, p), { recursive: true }); fs.utimesSync(path.join(sb.to, p), old, old);
  }
  fs.mkdirSync(path.join(sb.to, 'daily/.incoming-recent'));
  assert.equal(sb.run([]).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'daily')).sort(), ['.incoming-recent', '2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'weekly')), ['2026-11-06']);
  assert.deepEqual(fs.readdirSync(path.join(sb.to, 'monthly')), ['2026-11-06']);
});
```

- [ ] **Step 2: Run the tests and watch them fail.**
  Run `node --test tests/backup-shortcuts.test.js`. The new tests FAIL on their messages, and
  for the leftovers.

- [ ] **Step 3: Implement**, using spec §6 for the messages.
  - **The access check (step 1).** It runs first, before anything touches `to`.
    - `ENOENT` gives the no-library message.
    - `EPERM` gives the Full Disk Access message exactly as in the test. The node path is
      `fs.realpathSync(ctx.nodePath)`, falling back to `ctx.nodePath` if that throws.
    - Anything else gives `can't read …: <e.message>`.
  - **Copy failures.**
    - A spawn error with `ENOENT` gives the "sqlite3 not found" message.
    - Otherwise the reason is `timed out` on `ETIMEDOUT`. If not, it is the first non-empty stderr
      line, or failing that `exit <status>`.
  - **A failed check.** The message quotes the first line of stdout, or else of stderr.
  - **Names.** On failure, warn with
    `backup-shortcuts: warning: couldn't list shortcut names (<reason>); the backup is saved without shortcut-names.txt`.
    The reason works the same way as for the copy, plus `shortcuts not found` on `ENOENT`.
  - **Filesystem errors** become `can't write to <tildePath(to)>: <e.message>`. This covers reading
    the kind folders (any error except `ENOENT`), saving, promoting and pruning. Before throwing,
    remove this run's `.incoming-*` folders, as best effort.
  - **Tidy (step 2).** It runs after the access check. It removes `.incoming-*` and `.replaced-*`
    folders in each kind folder whose `mtimeMs` is more than 3,600,000 ms before `Date.now()`.
    It uses the real clock rather than `ctx.now()`, because modification times are real-clock
    values. Any error here is ignored.

- [ ] **Step 4: Run the tests and watch them pass.**
  Run `node --test tests/backup-shortcuts.test.js`, then `npm test`. Everything passes.

- [ ] **Step 5: Commit** with the message `feat: clear errors, Full Disk Access help and crash leftovers for Shortcuts backups`.

---

### Task 5: The routine and its instructions

**Files:**
- Create: `scripts/morning.sh` (mode 755). Its content is the code block in spec §4, exactly.
- Create: `tests/morning.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: the command line of the backup step:
  `node morning/backup-shortcuts.js --to "$HOME/Documents/Backups/Shortcuts"`.
- Produces: nothing in code.

**Test helper** `routine({ extraStep = false } = {})`, in `tests/morning.test.js`:
- It makes a real-pathed temporary `scripts/morning/` folder.
- It copies the repo's `scripts/morning.sh` there with mode 755. With `extraStep`, it first
  replaces the line `exit "$failed"` with `step "Second step" node morning/second.js`, a blank
  line, and `exit "$failed"`.
- It writes two stub steps, `morning/backup-shortcuts.js` and `morning/second.js`. Each one:
  - appends `JSON.stringify([name, ...argv])` to `$STUB_LOG`;
  - prints `<name> ran`;
  - exits with `$STUB_EXIT_<NAME>`, defaulting to 0.

  The names are `backup` and `second`.
- It returns:
  - `home`, which is `<tmp>/home`;
  - `calls()`;
  - `run({ cwd = <tmp>, env = {} } = {})`, which calls `spawnSync(<tmp>/scripts/morning.sh)`.
    Its env is `PATH = <dir of process.execPath>:/usr/bin:/bin`, `HOME = home` and `STUB_LOG`.

- [ ] **Step 1: Write the failing tests.**

```js
test('runs each step with a header and an ok line, and exits 0', () => {
  const r = routine().run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--- \d\d:\d\d:\d\d Back up Shortcuts\nbackup ran\n--- \d\d:\d\d:\d\d Back up Shortcuts: ok\n$/);
});

test('passes the backup folder under HOME to the backup step', () => {
  const rt = routine(); rt.run();
  assert.deepEqual(rt.calls(), [['backup', '--to', `${rt.home}/Documents/Backups/Shortcuts`]]);
});

test("a failed step doesn't stop the next one, and the routine exits 1", () => {
  const rt = routine({ extraStep: true }); const r = rt.run({ env: { STUB_EXIT_BACKUP: '3' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^--- \d\d:\d\d:\d\d Back up Shortcuts: FAILED \(exit 3\)$/m);
  assert.match(r.stdout, /^second ran$/m);
  assert.match(r.stdout, /^--- \d\d:\d\d:\d\d Second step: ok$/m);
});

test('works from any working folder', () => {
  const rt = routine(); const r = rt.run({ cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr); assert.equal(rt.calls().length, 1);
});
```

- [ ] **Step 2: Run the tests and watch them fail.**
  Run `node --test tests/morning.test.js`. Expect FAIL with `ENOENT` on `scripts/morning.sh`.

- [ ] **Step 3: Create `scripts/morning.sh`** from spec §4, then `chmod 755 scripts/morning.sh`.

- [ ] **Step 4: Run the tests and watch them pass.**
  Run `node --test tests/morning.test.js`, then `npm test`. Everything passes.

- [ ] **Step 5: Write the README changes.** Clear instructions were asked for, so keep the wording
  plain and every command copy-pasteable.
  - **Under the intro paragraph**, add:
    `**Included:** a morning routine that backs up your Apple Shortcuts every day. See [Morning routine](#morning-routine).`
  - **Under "Development"**, add:
    `The Shortcuts backup tests use a real sqlite3 when one is installed (macOS has it) and skip those checks otherwise.`
  - **A new `## Morning routine` section after "Writing scripts"**, following spec §8:
    1. One sentence on what it is.
    2. `### Set it up (once, on your Mac)`, with steps 1–3 from spec §8:
       - Each command goes in its own `bash` block.
       - Step 1 adds "press Return" after pasting the path.
       - Step 3 explains that `+2m` runs the routine once, the same way the 7:00 run will.
    3. `### What you get`:
       - the folder tree, with each file's purpose;
       - three bullets for the retention rules;
       - the log path, `logs/morning-0700.log`;
       - an example `step` line changing the counts (`--daily 14 --weekly 8 --monthly 24`).
    4. `### Add a step`: two numbered steps, using the example
       `step "Check the weather" bash morning/weather.sh`. Mention `node` and `python3`, that steps
       run in order, and that a failed step doesn't stop the others but does notify you.
    5. `### Restore a backup`:
       - Open with **This hasn't been tested yet; read it all before you start.**
       - Give the three warnings from spec §8. The Terminal permission is given the same way as
         setup step 1, adding the Terminal app from Applications → Utilities.
       - List spec §8's four steps, with this block for step 3. Edit only its first line; the
         `&&` chain stops before touching the library if the backup is missing:
         ```bash
         BACKUP=~/Documents/Backups/Shortcuts/daily/2026-11-05
         SAVED=~/Documents/Backups/Shortcuts/before-restore-$(date +%Y%m%d-%H%M%S)
         [ -f "$BACKUP/Shortcuts.sqlite.gz" ] && mkdir -p "$SAVED" && mv ~/Library/Shortcuts/Shortcuts.sqlite* "$SAVED"/ && gunzip -c "$BACKUP/Shortcuts.sqlite.gz" > ~/Library/Shortcuts/Shortcuts.sqlite && echo "Restored. Now restart your Mac."
         ```
       - End with the undo note, and say the routine never deletes `before-restore-…` folders.
    6. `### When something goes wrong`, with three bullets:
       - the notification, and `tail -n 20 logs/morning-0700.log`;
       - "macOS blocked access", which means repeating setup step 1. Explain why it happens again
         after `brew upgrade node`, and that the nodejs.org installer avoids it;
       - "no Shortcuts library", which means opening the Shortcuts app once.

- [ ] **Step 6: Check the README against the code.**
  Read the new section from top to bottom as a new user would, and confirm:
  - every path, file name, default and command matches `scripts/morning.sh` and `USAGE`;
  - `morning-0700` is the job id that `./wakecron add morning.sh 07:00` creates.

- [ ] **Step 7: Commit** `scripts/morning.sh`, `tests/morning.test.js` and `README.md` with the
  message `feat: morning routine that backs up Shortcuts at 07:00, with setup and restore instructions`.
