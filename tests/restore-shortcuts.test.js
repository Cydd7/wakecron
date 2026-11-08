'use strict';
// scripts/morning/restore-shortcuts.js against a throwaway HOME. Stand-in tools in tests/fakes/
// play pgrep and sqlite3; a few tests use the real sqlite3 where it is installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { main, shellArg } = require('../scripts/morning/restore-shortcuts');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'morning', 'restore-shortcuts.js');
const FAKE_TOOLS = path.join(__dirname, 'fakes', 'backup-tools.js');
const MAC_SQLITE = path.join(__dirname, 'fakes', 'mac-sqlite3.js');
const HAS_SQLITE = spawnSync('sqlite3', ['-version']).status === 0;
const SQLITE_DIR = HAS_SQLITE ? path.dirname(spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).stdout.trim()) : null;
const NOW = new Date(2026, 10, 8, 9, 30, 0);
const SAVED = 'before-restore-20261108-093000';
const UNDONE = 'undone-20261108-093000';
const CURRENT = { 'Shortcuts.sqlite': 'current', 'Shortcuts.sqlite-shm': 'current shm', 'Shortcuts.sqlite-wal': 'current wal' };
const ORIGINAL = { ...CURRENT, 'Spotlight.dat': 'other' };
const RESTORED = { 'Shortcuts.sqlite': 'backup db', 'Spotlight.dat': 'other' };
const USAGE_LINES = 'usage: restore-shortcuts.js BACKUP\n       restore-shortcuts.js --undo FOLDER\n';
const PREAMBLE = [
  'Backup: ~/Documents/Backups/Shortcuts/daily/2026-11-05/Shortcuts.sqlite.gz (saved 2026-11-05 07:00, 3 shortcuts)',
  'This replaces your whole Shortcuts library with the one in the backup.',
  `Your current library will be kept in ~/Documents/Backups/Shortcuts/${SAVED}.`,
].join('\n');

const sandboxes = [];
process.on('exit', () => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

const capture = () => ({ text: '', write(chunk) { this.text += chunk; } });

// Every file in dir mapped to its contents; {} when dir is missing.
function files(dir) {
  const found = {};
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return found;
  }
  for (const name of names) found[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  return found;
}

const failWith = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// A HOME with a Shortcuts library and one backup, daily/2026-11-05, saved at 07:00 that day.
// realSqlite: true puts this machine's sqlite3 on PATH; 'mac' puts it there acting like the Mac's.
function sandbox({ library = CURRENT, backup = 'backup db', names = 'Morning\nEvening\nZoom Link\n', realSqlite = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-')));
  sandboxes.push(dir);
  const home = path.join(dir, 'home');
  const lib = path.join(home, 'Library', 'Shortcuts');
  fs.mkdirSync(lib, { recursive: true });
  for (const [name, content] of Object.entries(library)) fs.writeFileSync(path.join(lib, name), content);
  fs.writeFileSync(path.join(lib, 'Spotlight.dat'), 'other');
  const root = path.join(home, 'Documents', 'Backups', 'Shortcuts');
  const folder = path.join(root, 'daily', '2026-11-05');
  fs.mkdirSync(folder, { recursive: true });
  const archive = path.join(folder, 'Shortcuts.sqlite.gz');
  fs.writeFileSync(archive, Buffer.isBuffer(backup) ? backup : zlib.gzipSync(backup));
  const savedAt = new Date(2026, 10, 5, 7, 0);
  fs.utimesSync(archive, savedAt, savedAt);
  if (names !== null) fs.writeFileSync(path.join(folder, 'shortcut-names.txt'), names);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const standIn = (tool) => fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TOOLS}" ${tool} "$@"\n`, { mode: 0o755 });
  standIn('pgrep');
  standIn('shortcuts'); // for the backup step in the round-trip test
  if (!realSqlite) standIn('sqlite3');
  if (realSqlite === 'mac') {
    fs.writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/sh\nexec "${process.execPath}" "${MAC_SQLITE}" "${path.join(SQLITE_DIR, 'sqlite3')}" "$@"\n`, { mode: 0o755 });
  }
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  const env = { HOME: home, PATH: realSqlite ? `${bin}:${SQLITE_DIR}` : bin };
  return {
    dir, home, lib, root, folder, archive, tmp, env,
    saved: path.join(root, SAVED),
    undone: path.join(root, UNDONE),
    run(argv, { answer = 'y', env: extra = {}, ...rest } = {}) {
      const stdout = capture();
      const stderr = capture();
      const asked = [];
      const ask = (question) => {
        asked.push(question);
        return answer;
      };
      const code = main(argv, {
        env: { ...env, ...extra }, now: () => NOW, stdout, stderr, tmpDir: tmp, ask,
        scriptPath: '/opt/wakecron/scripts/morning/restore-shortcuts.js', ...rest,
      });
      return { code, stdout: stdout.text, stderr: stderr.text, asked };
    },
  };
}

// Runs fn with fs[name] replaced by patch(original); always puts the original back.
function patched(name, patch, fn) {
  const original = fs[name];
  fs[name] = patch(original);
  try {
    return fn();
  } finally {
    fs[name] = original;
  }
}

// ---- Restore --------------------------------------------------------------------------------

test('restores the backup and keeps your current library aside', () => {
  const sb = sandbox();
  fs.chmodSync(path.join(sb.lib, 'Shortcuts.sqlite'), 0o640);
  const r = sb.run([sb.archive]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.asked, ['Restore this backup? [y/N] ']);
  assert.equal(r.stdout, `${PREAMBLE}\n${[
    `Restored. Your previous library is in ~/Documents/Backups/Shortcuts/${SAVED}.`,
    'Now restart your Mac, then open Shortcuts.',
    'To undo this, quit Shortcuts and run:',
    `  /opt/wakecron/scripts/morning/restore-shortcuts.js --undo ~/Documents/Backups/Shortcuts/${SAVED}`,
  ].join('\n')}\n`);
  assert.equal(r.stderr, '');
  assert.deepEqual(files(sb.lib), RESTORED);
  assert.equal(fs.statSync(path.join(sb.lib, 'Shortcuts.sqlite')).mode & 0o777, 0o640); // as the old one was
  assert.deepEqual(files(sb.saved), CURRENT);
  assert.equal(fs.statSync(sb.saved).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(sb.tmp), []); // the checked copy is gone
});

test('takes the backup folder as well as the file, a leading ~ and a relative path', () => {
  for (const given of [(sb) => sb.folder, () => '~/Documents/Backups/Shortcuts/daily/2026-11-05', (sb) => path.relative(process.cwd(), sb.archive)]) {
    const sb = sandbox();
    const r = sb.run([given(sb)]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(files(sb.lib), RESTORED);
  }
});

test('restores only on yes; any other answer changes nothing', () => {
  for (const answer of ['y', 'Y', 'yes', ' YES ']) {
    const sb = sandbox();
    assert.equal(sb.run([sb.archive], { answer }).code, 0, answer);
    assert.deepEqual(files(sb.lib), RESTORED, answer);
  }
  for (const answer of ['n', 'no', '', 'yep', 'y es']) {
    const sb = sandbox();
    const r = sb.run([sb.archive], { answer });
    assert.equal(r.code, 1, answer);
    assert.equal(r.stdout, `${PREAMBLE}\nNothing was changed.\n`, answer);
    assert.deepEqual(files(sb.lib), ORIGINAL, answer);
    assert.deepEqual(fs.readdirSync(sb.root), ['daily'], answer);
  }
});

test('with no current library it restores, with nothing to keep aside', () => {
  const sb = sandbox({ library: {} });
  const r = sb.run([sb.archive]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, [
    'Backup: ~/Documents/Backups/Shortcuts/daily/2026-11-05/Shortcuts.sqlite.gz (saved 2026-11-05 07:00, 3 shortcuts)',
    'This replaces your whole Shortcuts library with the one in the backup.',
    "You have no Shortcuts library right now, so there's nothing to keep aside.",
    'Restored.',
    'Now restart your Mac, then open Shortcuts.',
    '',
  ].join('\n'));
  assert.deepEqual(files(sb.lib), RESTORED);
  assert.equal(fs.statSync(path.join(sb.lib, 'Shortcuts.sqlite')).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(sb.root), ['daily']);
});

test('the summary counts the names saved with the backup, if there are any', () => {
  const one = sandbox({ names: 'Only One\n' });
  assert.match(one.run([one.archive], { answer: 'n' }).stdout, /^Backup: .* \(saved 2026-11-05 07:00, 1 shortcut\)$/m);
  const none = sandbox({ names: null });
  assert.match(none.run([none.archive], { answer: 'n' }).stdout, /^Backup: .* \(saved 2026-11-05 07:00\)$/m);
});

// ---- Checks before asking --------------------------------------------------------------------

test('each check fails before the question, and nothing is changed', () => {
  const cases = [
    {
      name: 'no such backup',
      argv: (sb) => [path.join(sb.root, 'daily', '2026-01-01')],
      stderr: 'restore-shortcuts: no backup at ~/Documents/Backups/Shortcuts/daily/2026-01-01. Nothing was changed.\n',
    },
    {
      name: 'a folder with no backup in it',
      argv: (sb) => [fs.mkdirSync(path.join(sb.root, 'daily', '2026-01-02'), { recursive: true })],
      stderr: 'restore-shortcuts: no backup at ~/Documents/Backups/Shortcuts/daily/2026-01-02/Shortcuts.sqlite.gz. Nothing was changed.\n',
    },
    {
      name: 'the Shortcuts app is open',
      env: { FAKE_PGREP: 'running' },
      stderr: 'restore-shortcuts: the Shortcuts app is open. Quit it, then try again. Nothing was changed.\n',
    },
    {
      name: 'not a gzip file',
      backup: Buffer.from('not gzip at all'),
      stderr: /^restore-shortcuts: that backup can't be read \(.+\)\. Nothing was changed\.\n$/,
    },
    {
      name: 'the copy fails the integrity check',
      env: { FAKE_CHECK: '*** in database main ***' },
      stderr: "restore-shortcuts: that backup failed SQLite's integrity check (*** in database main ***). Nothing was changed.\n",
    },
    {
      name: 'blocked by macOS privacy rules',
      ctx: { checkAccess: () => { throw failWith('EPERM', 'operation not permitted'); } },
      stderr: [
        'restore-shortcuts: macOS blocked access to ~/Library/Shortcuts (operation not permitted).',
        'Give Terminal Full Disk Access once: System Settings → Privacy & Security → Full Disk Access →',
        'click + → choose Applications → Utilities → Terminal → Open, and make sure its switch is on.',
        'Then quit Terminal, open it again and try again. Nothing was changed.',
        '',
      ].join('\n'),
    },
    {
      name: 'no Shortcuts folder',
      ctx: { checkAccess: () => { throw failWith('ENOENT', 'no such file or directory'); } },
      stderr: 'restore-shortcuts: no Shortcuts library folder at ~/Library/Shortcuts. Open the Shortcuts app once, quit it, then try again. Nothing was changed.\n',
    },
    {
      name: 'pgrep missing',
      env: { PATH: '/nonexistent' },
      stderr: "restore-shortcuts: can't check whether the Shortcuts app is open (pgrep not found). Nothing was changed.\n",
    },
  ];
  for (const c of cases) {
    const sb = sandbox({ backup: c.backup });
    const r = sb.run(c.argv ? c.argv(sb) : [sb.archive], { env: c.env, ...c.ctx });
    assert.equal(r.code, 1, c.name);
    if (typeof c.stderr === 'string') assert.equal(r.stderr, c.stderr, c.name);
    else assert.match(r.stderr, c.stderr, c.name);
    assert.deepEqual(r.asked, [], c.name);
    assert.deepEqual(files(sb.lib), ORIGINAL, c.name);
    assert.deepEqual(fs.readdirSync(sb.root), ['daily'], c.name);
    assert.deepEqual(fs.readdirSync(sb.tmp), [], c.name);
  }
});

test('sqlite3 missing from PATH is named as the problem', () => {
  const sb = sandbox();
  fs.rmSync(path.join(sb.dir, 'bin', 'sqlite3'));
  const r = sb.run([sb.archive]);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'restore-shortcuts: sqlite3 not found. It ships with macOS at /usr/bin/sqlite3; check PATH. Nothing was changed.\n');
});

// ---- Failures while restoring ----------------------------------------------------------------

test('if the before-restore folder already exists, your library is left exactly as it was', () => {
  const sb = sandbox();
  fs.mkdirSync(sb.saved);
  const r = sb.run([sb.archive]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^restore-shortcuts: restore failed \(EEXIST: .+\)\. Nothing was changed\.\n$/);
  assert.deepEqual(files(sb.lib), ORIGINAL);
  assert.ok(fs.existsSync(sb.saved)); // not ours, so not removed
});

test('if keeping your library aside fails partway, what moved is put back', () => {
  const sb = sandbox();
  const r = patched('renameSync', (rename) => (from, to) => {
    if (String(from).endsWith('-wal')) throw failWith('EIO', 'i/o error');
    return rename(from, to);
  }, () => sb.run([sb.archive]));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'restore-shortcuts: restore failed (EIO: i/o error). Nothing was changed.\n');
  assert.deepEqual(files(sb.lib), ORIGINAL);
  assert.deepEqual(fs.readdirSync(sb.root), ['daily']);
});

test('if something recreates a library file while restoring, it stops and puts everything back', () => {
  const sb = sandbox();
  const wal = path.join(sb.lib, 'Shortcuts.sqlite-wal');
  const r = patched('renameSync', (rename) => (from, to) => {
    rename(from, to);
    if (String(from) === wal) fs.writeFileSync(wal, 'made meanwhile'); // as one of Shortcuts' helpers might
  }, () => sb.run([sb.archive]));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'restore-shortcuts: restore failed (something recreated Shortcuts.sqlite-wal in ~/Library/Shortcuts). Nothing was changed.\n');
  assert.deepEqual(files(sb.lib), ORIGINAL);
  assert.deepEqual(fs.readdirSync(sb.root), ['daily']);
});

test("if putting the backup in place fails, a partial file is removed and your library put back", () => {
  for (const library of [CURRENT, {}]) {
    const sb = sandbox({ library });
    const target = path.join(sb.lib, 'Shortcuts.sqlite');
    const r = patched('copyFileSync', (copy) => (from, to, mode) => {
      if (String(to) !== target) return copy(from, to, mode);
      fs.writeFileSync(to, 'partial');
      throw failWith('ENOSPC', 'no space left on device');
    }, () => sb.run([sb.archive]));
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'restore-shortcuts: restore failed (ENOSPC: no space left on device). Nothing was changed.\n');
    assert.deepEqual(files(sb.lib), { ...library, 'Spotlight.dat': 'other' });
    assert.deepEqual(fs.readdirSync(sb.root), ['daily']);
  }
});

test('if putting your library back fails too, it says where every file is, and nothing is lost', () => {
  const sb = sandbox();
  const r = patched('renameSync', (rename) => (from, to) => {
    if (String(from).endsWith('-wal')) throw failWith('EIO', 'i/o error');
    if (String(to) === path.join(sb.lib, 'Shortcuts.sqlite')) throw failWith('EIO', 'still failing');
    return rename(from, to);
  }, () => sb.run([sb.archive]));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, [
    'restore-shortcuts: restore failed (EIO: i/o error), and putting your library back failed too (EIO: still failing).',
    `Nothing was deleted: your library's files are in ~/Library/Shortcuts and ~/Documents/Backups/Shortcuts/${SAVED}.`,
    '',
  ].join('\n'));
  assert.deepEqual({ ...files(sb.lib), ...files(sb.saved) }, ORIGINAL);
});

// ---- Undo -----------------------------------------------------------------------------------

test('undo puts your library back and keeps the restored one aside, without mixing them', () => {
  const sb = sandbox();
  assert.equal(sb.run([sb.archive]).code, 0);
  fs.writeFileSync(path.join(sb.lib, 'Shortcuts.sqlite-wal'), 'restored wal'); // made by the restored library
  const r = sb.run(['--undo', sb.saved]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.asked, ['Undo the restore? [y/N] ']);
  assert.equal(r.stdout, [
    `Putting back the library kept in ~/Documents/Backups/Shortcuts/${SAVED}.`,
    `The library you have now will be kept in ~/Documents/Backups/Shortcuts/${UNDONE}.`,
    `Undone. The restored library is in ~/Documents/Backups/Shortcuts/${UNDONE}.`,
    'Now restart your Mac, then open Shortcuts.',
    '',
  ].join('\n'));
  assert.deepEqual(files(sb.lib), ORIGINAL);
  assert.deepEqual(files(sb.undone), { 'Shortcuts.sqlite': 'backup db', 'Shortcuts.sqlite-wal': 'restored wal' });
  assert.equal(fs.existsSync(sb.saved), false); // emptied, so removed
});

test('undo checks first and asks; no, or a folder without a saved library, changes nothing', () => {
  const sb = sandbox();
  assert.equal(sb.run([sb.archive]).code, 0);
  const missing = sb.run(['--undo', path.join(sb.root, 'before-restore-missing')]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, 'restore-shortcuts: no saved library in ~/Documents/Backups/Shortcuts/before-restore-missing. Nothing was changed.\n');
  const open = sb.run(['--undo', sb.saved], { env: { FAKE_PGREP: 'running' } });
  assert.equal(open.code, 1);
  assert.equal(open.stderr, 'restore-shortcuts: the Shortcuts app is open. Quit it, then try again. Nothing was changed.\n');
  assert.deepEqual([...missing.asked, ...open.asked], []);
  const no = sb.run(['--undo', sb.saved], { answer: 'n' });
  assert.equal(no.code, 1);
  assert.match(no.stdout, /\nNothing was changed\.\n$/);
  assert.deepEqual(files(sb.lib), RESTORED);
  assert.deepEqual(files(sb.saved), CURRENT);
});

test('if undo fails partway, everything goes back where it was', () => {
  const sb = sandbox();
  assert.equal(sb.run([sb.archive]).code, 0);
  const r = patched('renameSync', (rename) => (from, to) => {
    if (String(from) === path.join(sb.saved, 'Shortcuts.sqlite-wal')) throw failWith('EIO', 'i/o error');
    return rename(from, to);
  }, () => sb.run(['--undo', sb.saved]));
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'restore-shortcuts: undo failed (EIO: i/o error). Nothing was changed.\n');
  assert.deepEqual(files(sb.lib), RESTORED);
  assert.deepEqual(files(sb.saved), CURRENT);
  assert.equal(fs.existsSync(sb.undone), false);
});

// ---- Usage ----------------------------------------------------------------------------------

test('bad usage exits 2 with the problem and the usage lines', () => {
  const sb = sandbox();
  const cases = [
    [[], 'which backup? Give the path of its Shortcuts.sqlite.gz'],
    [['--undo'], '--undo needs the folder a restore kept your library in'],
    [['a.gz', 'b.gz'], 'unexpected argument "b.gz"'],
    [['--force', 'a.gz'], 'unknown option "--force"'],
    [['a.gz', '--undo', 'x'], 'give a backup to restore, or --undo, not both'],
  ];
  for (const [argv, message] of cases) {
    const r = sb.run(argv);
    assert.equal(r.code, 2, message);
    assert.equal(r.stderr, `restore-shortcuts: ${message}\n${USAGE_LINES}`, message);
  }
  assert.deepEqual(files(sb.lib), ORIGINAL);
});

test('--help prints the usage and exits 0', () => {
  const r = sandbox().run(['--help']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, [
    'usage: restore-shortcuts.js BACKUP',
    '       restore-shortcuts.js --undo FOLDER',
    'Restores your Apple Shortcuts library from a backup, keeping your current library aside.',
    "  BACKUP          a backup's Shortcuts.sqlite.gz, or the folder that holds it",
    '  --undo FOLDER   put back the library that a restore kept in FOLDER',
    '',
  ].join('\n'));
});

test('paths in the printed undo command are quoted only when they must be', () => {
  const home = '/Users/cydd';
  assert.equal(shellArg('/Users/cydd/wakecron/scripts/morning/restore-shortcuts.js', home), '~/wakecron/scripts/morning/restore-shortcuts.js');
  assert.equal(shellArg('/opt/wakecron/restore-shortcuts.js', home), '/opt/wakecron/restore-shortcuts.js');
  assert.equal(shellArg('/Users/cydd/My Projects/x.js', home), "'/Users/cydd/My Projects/x.js'");
  assert.equal(shellArg("/Users/cydd/it's/x.js", home), "'/Users/cydd/it'\\''s/x.js'");
  assert.equal(shellArg('/Users/cydd/a$b', home), "'/Users/cydd/a$b'");
});

// ---- With the real sqlite3 ------------------------------------------------------------------

test("a backup that isn't an SQLite database fails the check (real sqlite3)", { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, () => {
  const sb = sandbox({ backup: 'just some text', realSqlite: true });
  const r = sb.run([sb.archive]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^restore-shortcuts: that backup failed SQLite's integrity check \(.*not a database.*\)\. Nothing was changed\.\n$/);
  assert.deepEqual(files(sb.lib), ORIGINAL);
});

test("a WAL-mode backup, made the way the routine makes them, passes the check with a sqlite3 like the Mac's",
  { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-wal-')));
    sandboxes.push(work);
    const db = path.join(work, 'library.sqlite');
    const copy = path.join(work, 'copy.sqlite');
    const sql = (args) => assert.equal(spawnSync('sqlite3', ['-init', '/dev/null', ...args]).status, 0);
    sql([db, "PRAGMA journal_mode=WAL; CREATE TABLE ZSHORTCUT (ZNAME TEXT); INSERT INTO ZSHORTCUT VALUES ('Morning');"]);
    sql(['-readonly', db, `.backup "${copy}"`]);
    assert.deepEqual([...fs.readFileSync(copy).subarray(18, 20)], [2, 2]); // the copy is in WAL mode
    const sb = sandbox({ backup: zlib.gzipSync(fs.readFileSync(copy)), realSqlite: 'mac' });
    const r = sb.run([sb.archive]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(path.join(sb.lib, 'Shortcuts.sqlite')), fs.readFileSync(copy));
  });

test('round trip: a backup the backup step made is restored, later changes left out (real sqlite3)',
  { skip: !HAS_SQLITE && 'sqlite3 is not installed' }, () => {
    const sb = sandbox({ library: {}, realSqlite: true });
    const db = path.join(sb.lib, 'Shortcuts.sqlite');
    const sql = (query) => {
      const r = spawnSync('sqlite3', ['-init', '/dev/null', db, query], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    sql("PRAGMA journal_mode=WAL; CREATE TABLE ZSHORTCUT (ZNAME TEXT); INSERT INTO ZSHORTCUT VALUES ('Morning');");
    const backup = require('../scripts/morning/backup-shortcuts');
    const err = capture();
    const made = backup.main([], { env: { ...sb.env, FAKE_NAMES: 'Morning\n' }, now: () => NOW, stdout: capture(), stderr: err, tmpDir: sb.tmp });
    assert.equal(made, 0, err.text);
    sql("INSERT INTO ZSHORTCUT VALUES ('Added later');");
    const r = sb.run([path.join(sb.root, 'daily', '2026-11-08')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Backup: ~\/Documents\/Backups\/Shortcuts\/daily\/2026-11-08\/Shortcuts\.sqlite\.gz \(saved .*, 1 shortcut\)$/m);
    assert.equal(sql('SELECT ZNAME FROM ZSHORTCUT;'), 'Morning\n');
    const saved = path.join(sb.saved, 'Shortcuts.sqlite');
    assert.equal(spawnSync('sqlite3', ['-init', '/dev/null', saved, 'SELECT count(*) FROM ZSHORTCUT;'], { encoding: 'utf8' }).stdout, '2\n');
  });

// ---- As a command ---------------------------------------------------------------------------

// The sandbox's tools, plus node for the script's #! line.
const commandEnv = (sb) => ({ ...sb.env, PATH: `${sb.env.PATH}:${path.dirname(process.execPath)}` });

test('as a command: answering y restores, and the undo command it prints works pasted into a shell', () => {
  const sb = sandbox();
  const r = spawnSync(SCRIPT, [sb.archive], { env: commandEnv(sb), input: 'y\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Restore this backup\? \[y\/N\] Restored\./);
  assert.deepEqual(files(sb.lib), RESTORED);
  const undo = r.stdout.split('\n').find((line) => line.includes(' --undo ')).trim();
  const u = spawnSync('/bin/sh', ['-c', undo], { env: commandEnv(sb), input: 'y\n', encoding: 'utf8' });
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(files(sb.lib), ORIGINAL);
});

test('as a command: with no answer (nothing on stdin) nothing changes', () => {
  const sb = sandbox();
  const r = spawnSync(SCRIPT, [sb.archive], { env: commandEnv(sb), input: '', encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Restore this backup\? \[y\/N\] \nNothing was changed\.\n$/);
  assert.deepEqual(files(sb.lib), ORIGINAL);
});
