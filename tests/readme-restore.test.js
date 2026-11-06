'use strict';
// The README's "Restore a backup" commands, run as written against a throwaway HOME, in bash
// and (when installed) zsh, the default shell on a Mac.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const section = (README.split('\n### Restore a backup\n')[1] || '').split('\n### ')[0];

// The fenced bash blocks of that section, with the list indentation removed.
function dedent(text) {
  const lines = text.replace(/\n$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return `${lines.map((l) => l.slice(indent)).join('\n')}\n`;
}
const blocks = [...section.matchAll(/^ *```bash\n([\s\S]*?)^ *```$/gm)].map((m) => dedent(m[1]));
const [RESTORE, UNDO] = blocks;

const SHELLS = ['bash', 'zsh'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0);

const dirs = [];
process.on('exit', () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const files = (dir) => {
  const found = {};
  for (const name of fs.readdirSync(dir).sort()) found[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  return found;
};

// A HOME with a Shortcuts library and one backup at the path the README's first line names.
function mac({ library = { 'Shortcuts.sqlite': 'current', 'Shortcuts.sqlite-wal': 'current wal' }, backup = zlib.gzipSync('backup') } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-')));
  dirs.push(home);
  const lib = path.join(home, 'Library', 'Shortcuts');
  fs.mkdirSync(lib, { recursive: true });
  for (const [name, content] of Object.entries(library)) fs.writeFileSync(path.join(lib, name), content);
  fs.writeFileSync(path.join(lib, 'Spotlight.dat'), 'other');
  const backups = path.join(home, 'Documents', 'Backups', 'Shortcuts');
  fs.mkdirSync(path.join(backups, 'daily', '2026-11-05'), { recursive: true });
  fs.writeFileSync(path.join(backups, 'daily', '2026-11-05', 'Shortcuts.sqlite.gz'), backup);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  return {
    lib,
    backups,
    run(shell, script, { path: extraPath } = {}) {
      return spawnSync(shell, ['-c', script], { encoding: 'utf8', env: { HOME: home, PATH: `${extraPath ? `${extraPath}:` : ''}/usr/bin:/bin` } });
    },
    saved: (prefix) => fs.readdirSync(backups).filter((name) => name.startsWith(prefix)).map((name) => path.join(backups, name)),
    // An mv that refuses to move -wal files, to make a move fail partway.
    brokenMv() {
      fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/sh\nfor a in "$@"; do case "$a" in *-wal) echo "mv: refused $a" >&2; exit 1;; esac; done\nexec /bin/mv "$@"\n', { mode: 0o755 });
      return bin;
    },
  };
}

test('the README has a restore block and an undo block', () => {
  assert.equal(blocks.length, 2);
});

for (const shell of SHELLS) {
  test(`${shell}: restoring puts the backup in place and keeps your library aside`, () => {
    const m = mac();
    const r = m.run(shell, RESTORE);
    assert.equal(r.stdout, 'Restored. Now restart your Mac.\n', r.stderr);
    assert.deepEqual(files(m.lib), { 'Shortcuts.sqlite': 'backup', 'Spotlight.dat': 'other' });
    const [saved, ...more] = m.saved('before-restore-');
    assert.deepEqual(more, []);
    assert.deepEqual(files(saved), { 'Shortcuts.sqlite': 'current', 'Shortcuts.sqlite-wal': 'current wal' });
  });

  test(`${shell}: a damaged backup changes nothing`, () => {
    const m = mac({ backup: 'not a gzip file' });
    const r = m.run(shell, RESTORE);
    assert.match(r.stdout, /^That backup can't be read\. Nothing was changed\.$/m);
    assert.deepEqual(files(m.lib), { 'Shortcuts.sqlite': 'current', 'Shortcuts.sqlite-wal': 'current wal', 'Spotlight.dat': 'other' });
  });

  test(`${shell}: a missing library can still be restored`, () => {
    const m = mac({ library: {} });
    const r = m.run(shell, RESTORE);
    assert.equal(r.stdout, 'Restored. Now restart your Mac.\n', r.stderr);
    assert.deepEqual(files(m.lib), { 'Shortcuts.sqlite': 'backup', 'Spotlight.dat': 'other' });
  });

  test(`${shell}: if moving your library aside fails partway, nothing is unpacked over it`, () => {
    const m = mac();
    const r = m.run(shell, RESTORE, { path: m.brokenMv() });
    assert.match(r.stdout, /^Restore failed\. /m);
    assert.equal(fs.existsSync(path.join(m.lib, 'Shortcuts.sqlite')) && files(m.lib)['Shortcuts.sqlite'] === 'backup', false);
    assert.equal(files(m.lib)['Shortcuts.sqlite-wal'], 'current wal');
  });

  test(`${shell}: undo puts your library back and moves the restored one aside, without mixing them`, () => {
    const m = mac();
    m.run(shell, RESTORE);
    fs.writeFileSync(path.join(m.lib, 'Shortcuts.sqlite-wal'), 'restored wal'); // left by the restored library
    const [saved] = m.saved('before-restore-');
    const r = m.run(shell, UNDO.replace(/^SAVED=.*$/m, `SAVED=${saved}`));
    assert.equal(r.stdout, 'Undone. Now restart your Mac.\n', r.stderr);
    assert.deepEqual(files(m.lib), { 'Shortcuts.sqlite': 'current', 'Shortcuts.sqlite-wal': 'current wal', 'Spotlight.dat': 'other' });
    const [undone] = m.saved('undone-');
    assert.deepEqual(files(undone), { 'Shortcuts.sqlite': 'backup', 'Shortcuts.sqlite-wal': 'restored wal' });
  });

  test(`${shell}: undo refuses a folder with no saved library`, () => {
    const m = mac();
    const r = m.run(shell, UNDO.replace(/^SAVED=.*$/m, `SAVED=${m.backups}/before-restore-missing`));
    assert.match(r.stdout, /^No saved library in .*before-restore-missing\. Nothing was changed\.$/m);
    assert.deepEqual(files(m.lib), { 'Shortcuts.sqlite': 'current', 'Shortcuts.sqlite-wal': 'current wal', 'Spotlight.dat': 'other' });
  });
}
