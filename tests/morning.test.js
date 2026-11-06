'use strict';
// scripts/morning.sh, run as written, with stand-in step scripts in a throwaway scripts/ folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

const dirs = [];
process.on('exit', () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A stand-in step: logs its name and arguments, says it ran, exits with $STUB_EXIT_<NAME>.
const stub = (name) => [
  "const fs = require('node:fs');",
  `fs.appendFileSync(process.env.STUB_LOG, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');`,
  `console.log(${JSON.stringify(`${name} ran`)});`,
  `process.exit(Number(process.env.STUB_EXIT_${name.toUpperCase()} || 0));`,
  '',
].join('\n');

function routine({ extraStep = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'morning-test-')));
  dirs.push(dir);
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(path.join(scripts, 'morning'), { recursive: true });
  let text = fs.readFileSync(path.join(REPO, 'scripts', 'morning.sh'), 'utf8');
  if (extraStep) text = text.replace(/^exit "\$failed"$/m, 'step "Second step" node morning/second.js\n\nexit "$failed"');
  fs.writeFileSync(path.join(scripts, 'morning.sh'), text, { mode: 0o755 });
  fs.writeFileSync(path.join(scripts, 'morning', 'backup-shortcuts.js'), stub('backup'));
  fs.writeFileSync(path.join(scripts, 'morning', 'second.js'), stub('second'));
  const home = path.join(dir, 'home');
  const log = path.join(dir, 'calls.jsonl');
  return {
    home,
    calls() {
      try {
        return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    run({ cwd = dir, env = {} } = {}) {
      return spawnSync(path.join(scripts, 'morning.sh'), [], {
        cwd,
        encoding: 'utf8',
        env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, STUB_LOG: log, ...env },
      });
    },
  };
}

test('runs each step with a header and an ok line, and exits 0', () => {
  const r = routine().run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--- \d\d:\d\d:\d\d Back up Shortcuts\nbackup ran\n--- \d\d:\d\d:\d\d Back up Shortcuts: ok\n$/);
});

test('passes the backup folder under HOME to the backup step', () => {
  const rt = routine();
  rt.run();
  assert.deepEqual(rt.calls(), [['backup', '--to', `${rt.home}/Documents/Backups/Shortcuts`]]);
});

test("a failed step doesn't stop the next one, and the routine exits 1", () => {
  const rt = routine({ extraStep: true });
  const r = rt.run({ env: { STUB_EXIT_BACKUP: '3' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^--- \d\d:\d\d:\d\d Back up Shortcuts: FAILED \(exit 3\)$/m);
  assert.match(r.stdout, /^second ran$/m);
  assert.match(r.stdout, /^--- \d\d:\d\d:\d\d Second step: ok$/m);
});

test('works from any working folder', () => {
  const rt = routine();
  const r = rt.run({ cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rt.calls().length, 1);
});
