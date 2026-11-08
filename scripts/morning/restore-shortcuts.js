#!/usr/bin/env node
'use strict';
// Restores the Apple Shortcuts library from a backup made by backup-shortcuts.js, or undoes a
// restore. Run it by hand in Terminal: it checks everything first and asks before changing
// anything, and it always keeps the current library aside so the change can be undone.
// Design: docs/superpowers/specs/2026-11-06-morning-routine-design.md

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  ARCHIVE, NAMES_FILE, NO_STARTUP_FILE, UsageError, failureReason, firstLine, immutableUri, tildePath,
} = require('./backup-shortcuts');

const USAGE = [
  'usage: restore-shortcuts.js BACKUP',
  '       restore-shortcuts.js --undo FOLDER',
  'Restores your Apple Shortcuts library from a backup, keeping your current library aside.',
  "  BACKUP          a backup's Shortcuts.sqlite.gz, or the folder that holds it",
  '  --undo FOLDER   put back the library that a restore kept in FOLDER',
].join('\n');

const NOTHING_CHANGED = 'Nothing was changed.';
const RESTART = 'Now restart your Mac, then open Shortcuts.';

// A problem the person can fix; main prints it and exits 1.
class Failure extends Error {}
// The person didn't say yes; main prints it and exits 1.
class Declined extends Error {}

// ---- Options and text (pure) ------------------------------------------------------------------

function parseArgs(argv, home, cwd = process.cwd()) {
  const expand = (p) => path.resolve(cwd, p === '~' || p.startsWith('~/') ? home + p.slice(1) : p);
  const args = { help: false, backup: null, undo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--undo' || arg.startsWith('--undo=')) {
      const value = arg === '--undo' ? argv[(i += 1)] : arg.slice('--undo='.length);
      if (!value) throw new UsageError('--undo needs the folder a restore kept your library in');
      args.undo = expand(value);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option "${arg}"`);
    } else if (args.backup !== null) {
      throw new UsageError(`unexpected argument "${arg}"`);
    } else {
      args.backup = expand(arg);
    }
  }
  if (args.help) return args;
  if (args.backup !== null && args.undo !== null) throw new UsageError('give a backup to restore, or --undo, not both');
  if (args.backup === null && args.undo === null) throw new UsageError('which backup? Give the path of its Shortcuts.sqlite.gz');
  return args;
}

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d) => `${day(d).replace(/-/g, '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const minute = (d) => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// p as one word of a command to paste into a shell: the ~ form when that needs no quotes.
function shellArg(p, home) {
  const short = tildePath(p, home);
  if (short === '~' || /^~?[\w./@%+,:-]+$/.test(short)) return short;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

// ---- Files ------------------------------------------------------------------------------------

const statOf = (p) => fs.statSync(p, { throwIfNoEntry: false });

// The library's own files in dir: the database and its -wal and -shm companions.
const libraryFiles = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('Shortcuts.sqlite')).sort();

// How many shortcut names were saved with the backup, or null without a names file.
function namesCount(archive) {
  try {
    return fs.readFileSync(path.join(path.dirname(archive), NAMES_FILE), 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return null;
  }
}

// ---- Asking -----------------------------------------------------------------------------------

// Writes the question, then reads one line from stdin: '' when stdin is closed or empty.
function askLine(question) {
  process.stdout.write(question);
  const byte = Buffer.alloc(1);
  let answer = '';
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, byte, 0, 1, null);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      if (e.code !== 'EOF') throw e;
      n = 0;
    }
    if (n === 0) {
      process.stdout.write('\n');
      return answer;
    }
    if (byte[0] === 0x0a) return answer;
    answer += String.fromCharCode(byte[0]);
  }
}

function confirm(ctx, question) {
  if (!/^\s*y(es)?\s*$/i.test(ctx.ask(question) || '')) throw new Declined(NOTHING_CHANGED);
}

// ---- Checks, made before asking -----------------------------------------------------------------

function withDefaults(ctx) {
  return {
    env: process.env,
    now: () => new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    checkAccess: (dir) => fs.readdirSync(dir),
    ask: askLine,
    tmpDir: os.tmpdir(),
    scriptPath: __filename,
    ...ctx,
  };
}

function checkAppClosed(ctx) {
  const r = spawnSync('pgrep', ['-x', 'Shortcuts'], { env: ctx.env, encoding: 'utf8' });
  const cantCheck = (why) => new Failure(`can't check whether the Shortcuts app is open (${why}). ${NOTHING_CHANGED}`);
  if (r.error) throw cantCheck(r.error.code === 'ENOENT' ? 'pgrep not found' : r.error.message);
  if (r.status === 0) throw new Failure(`the Shortcuts app is open. Quit it, then try again. ${NOTHING_CHANGED}`);
  if (r.status !== 1) throw cantCheck(failureReason(r));
}

function checkLibraryFolder(lib, ctx, home) {
  const folder = tildePath(lib, home);
  try {
    ctx.checkAccess(lib);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Failure(`no Shortcuts library folder at ${folder}. Open the Shortcuts app once, quit it, then try again. ${NOTHING_CHANGED}`);
    if (e.code === 'EPERM') {
      throw new Failure([
        `macOS blocked access to ${folder} (operation not permitted).`,
        'Give Terminal Full Disk Access once: System Settings → Privacy & Security → Full Disk Access →',
        'click + → choose Applications → Utilities → Terminal → Open, and make sure its switch is on.',
        `Then quit Terminal, open it again and try again. ${NOTHING_CHANGED}`,
      ].join('\n'));
    }
    throw new Failure(`can't read ${folder}: ${e.message}. ${NOTHING_CHANGED}`);
  }
}

// The backup unpacked into temp and checked by SQLite. Nothing outside temp is touched.
function unpackChecked(archive, temp, ctx) {
  let data;
  try {
    data = zlib.gunzipSync(fs.readFileSync(archive));
  } catch (e) {
    throw new Failure(`that backup can't be read (${e.message}). ${NOTHING_CHANGED}`);
  }
  const copy = path.join(temp, 'Shortcuts.sqlite');
  fs.writeFileSync(copy, data, { mode: 0o600 });
  const checked = spawnSync('sqlite3', [...NO_STARTUP_FILE, '-readonly', immutableUri(copy), 'PRAGMA quick_check;'], {
    env: ctx.env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
  });
  if (checked.error && checked.error.code === 'ENOENT') throw new Failure(`sqlite3 not found. It ships with macOS at /usr/bin/sqlite3; check PATH. ${NOTHING_CHANGED}`);
  if (checked.error || checked.status !== 0 || checked.stdout.trim() !== 'ok') {
    const detail = firstLine(checked.stdout) || firstLine(checked.stderr) || failureReason(checked);
    throw new Failure(`that backup failed SQLite's integrity check (${detail}). ${NOTHING_CHANGED}`);
  }
  return copy;
}

// ---- Changing the library ---------------------------------------------------------------------

// Runs each undo step, collecting the messages of any that fail.
function undoSteps(steps) {
  const problems = [];
  for (const step of steps) {
    try {
      step();
    } catch (e) {
      problems.push(e.message);
    }
  }
  return problems;
}

// Moves every library file into saved, then puts the checked copy in place. If anything fails,
// it puts everything back. Returns whether there was a library to keep aside.
function swapIn(copy, lib, saved, home) {
  const target = path.join(lib, 'Shortcuts.sqlite');
  const current = libraryFiles(lib);
  const mode = current.includes('Shortcuts.sqlite') ? fs.statSync(target).mode & 0o777 : 0o644;
  const moved = [];
  let madeSaved = false;
  let placing = false;
  try {
    if (current.length > 0) {
      fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
      fs.mkdirSync(saved, { mode: 0o700 });
      madeSaved = true;
      for (const name of current) {
        fs.renameSync(path.join(lib, name), path.join(saved, name));
        moved.push(name);
      }
    }
    const left = libraryFiles(lib);
    if (left.length > 0) throw new Error(`something recreated ${left.join(', ')} in ${tildePath(lib, home)}`);
    placing = true; // from here on, anything at target is this restore's
    fs.copyFileSync(copy, target);
    fs.chmodSync(target, mode);
    return current.length > 0;
  } catch (e) {
    const problems = undoSteps([
      ...(placing ? [() => fs.rmSync(target, { force: true })] : []),
      ...moved.reverse().map((name) => () => fs.renameSync(path.join(saved, name), path.join(lib, name))),
      ...(madeSaved ? [() => { if (fs.readdirSync(saved).length === 0) fs.rmdirSync(saved); }] : []),
    ]);
    if (problems.length === 0) throw new Failure(`restore failed (${e.message}). ${NOTHING_CHANGED}`);
    throw new Failure(`restore failed (${e.message}), and putting your library back failed too (${problems[0]}).\n`
      + `Nothing was deleted: your library's files are in ${tildePath(lib, home)} and ${tildePath(saved, home)}.`);
  }
}

// Moves the current library files into undone, then the saved ones back into the library. If
// anything fails, it puts everything back. Returns whether there was a library to keep aside.
function swapBack(folder, lib, undone, home) {
  const current = libraryFiles(lib);
  const saved = libraryFiles(folder);
  const aside = [];
  const back = [];
  let madeUndone = false;
  try {
    if (current.length > 0) {
      fs.mkdirSync(path.dirname(undone), { recursive: true, mode: 0o700 });
      fs.mkdirSync(undone, { mode: 0o700 });
      madeUndone = true;
      for (const name of current) {
        fs.renameSync(path.join(lib, name), path.join(undone, name));
        aside.push(name);
      }
    }
    const left = libraryFiles(lib);
    if (left.length > 0) throw new Error(`something recreated ${left.join(', ')} in ${tildePath(lib, home)}`);
    for (const name of saved) {
      fs.renameSync(path.join(folder, name), path.join(lib, name));
      back.push(name);
    }
    return current.length > 0;
  } catch (e) {
    const problems = undoSteps([
      ...back.reverse().map((name) => () => fs.renameSync(path.join(lib, name), path.join(folder, name))),
      ...aside.reverse().map((name) => () => fs.renameSync(path.join(undone, name), path.join(lib, name))),
      ...(madeUndone ? [() => { if (fs.readdirSync(undone).length === 0) fs.rmdirSync(undone); }] : []),
    ]);
    if (problems.length === 0) throw new Failure(`undo failed (${e.message}). ${NOTHING_CHANGED}`);
    throw new Failure(`undo failed (${e.message}), and putting things back failed too (${problems[0]}).\n`
      + `Nothing was deleted: the files are in ${tildePath(lib, home)}, ${tildePath(folder, home)} and ${tildePath(undone, home)}.`);
  }
}

// ---- The two commands -------------------------------------------------------------------------

const places = (home) => ({
  lib: path.join(home, 'Library', 'Shortcuts'),
  root: path.join(home, 'Documents', 'Backups', 'Shortcuts'),
});

const keepingLine = (lib, folder, home, what) => (libraryFiles(lib).length > 0
  ? `${what} will be kept in ${tildePath(folder, home)}.`
  : "You have no Shortcuts library right now, so there's nothing to keep aside.");

function restore(backup, ctx, home) {
  const { lib, root } = places(home);
  const archive = statOf(backup)?.isDirectory() ? path.join(backup, ARCHIVE) : backup;
  if (!statOf(archive)?.isFile()) throw new Failure(`no backup at ${tildePath(archive, home)}. ${NOTHING_CHANGED}`);
  checkAppClosed(ctx);
  checkLibraryFolder(lib, ctx, home);

  const temp = fs.mkdtempSync(path.join(ctx.tmpDir, 'restore-shortcuts-'));
  try {
    const copy = unpackChecked(archive, temp, ctx);
    const saved = path.join(root, `before-restore-${stamp(ctx.now())}`);
    const count = namesCount(archive);
    const about = [`saved ${minute(fs.statSync(archive).mtime)}`, ...(count === null ? [] : [plural(count, 'shortcut')])];
    ctx.stdout.write(`Backup: ${tildePath(archive, home)} (${about.join(', ')})\n`);
    ctx.stdout.write('This replaces your whole Shortcuts library with the one in the backup.\n');
    ctx.stdout.write(`${keepingLine(lib, saved, home, 'Your current library')}\n`);
    confirm(ctx, 'Restore this backup? [y/N] ');

    if (!swapIn(copy, lib, saved, home)) return ['Restored.', RESTART];
    return [
      `Restored. Your previous library is in ${tildePath(saved, home)}.`,
      RESTART,
      'To undo this, quit Shortcuts and run:',
      `  ${shellArg(ctx.scriptPath, home)} --undo ${shellArg(saved, home)}`,
    ];
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function undo(folder, ctx, home) {
  const { lib, root } = places(home);
  if (!statOf(path.join(folder, 'Shortcuts.sqlite'))?.isFile()) throw new Failure(`no saved library in ${tildePath(folder, home)}. ${NOTHING_CHANGED}`);
  checkAppClosed(ctx);
  checkLibraryFolder(lib, ctx, home);

  const undone = path.join(root, `undone-${stamp(ctx.now())}`);
  ctx.stdout.write(`Putting back the library kept in ${tildePath(folder, home)}.\n`);
  ctx.stdout.write(`${keepingLine(lib, undone, home, 'The library you have now')}\n`);
  confirm(ctx, 'Undo the restore? [y/N] ');

  const keptAside = swapBack(folder, lib, undone, home);
  if (path.basename(folder).startsWith('before-restore-')) {
    try {
      fs.rmdirSync(folder); // only once empty
    } catch {
      // it still holds other files: keep it
    }
  }
  return [keptAside ? `Undone. The restored library is in ${tildePath(undone, home)}.` : 'Undone.', RESTART];
}

function main(argv, ctx = {}) {
  const c = withDefaults(ctx);
  const home = c.env.HOME || os.homedir();
  try {
    const args = parseArgs(argv, home);
    if (args.help) {
      c.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const lines = args.undo !== null ? undo(args.undo, c, home) : restore(args.backup, c, home);
    for (const line of lines) c.stdout.write(`${line}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      c.stderr.write(`restore-shortcuts: ${e.message}\n${USAGE.split('\n').slice(0, 2).join('\n')}\n`);
      return 2;
    }
    if (e instanceof Declined) {
      c.stdout.write(`${e.message}\n`);
      return 1;
    }
    if (e instanceof Failure) {
      c.stderr.write(`restore-shortcuts: ${e.message}\n`);
      return 1;
    }
    c.stderr.write(`restore-shortcuts: unexpected error: ${e.message}\n`);
    return 1;
  }
}

module.exports = { main, shellArg };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
