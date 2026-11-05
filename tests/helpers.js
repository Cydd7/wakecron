'use strict';
// Test sandboxes: a throwaway copy of the project with its own HOME and a bin/ folder of fake
// macOS tools (tests/fakes/fake-tool.js), plus helpers to inspect what those fakes recorded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createContext } = require('../lib/paths');

const REPO = path.resolve(__dirname, '..');
const FAKE_TOOL = path.join(__dirname, 'fakes', 'fake-tool.js');
const FAKE_NAMES = ['launchctl', 'pmset', 'caffeinate', 'osascript', 'sudo', 'visudo', 'install', 'rm'];

const sandboxes = [];
process.on('exit', () => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

// A writable stream that keeps everything written to it in `.text`.
function capture() {
  const stream = new Writable({
    write(chunk, _encoding, done) {
      stream.text += chunk.toString();
      done();
    },
  });
  stream.text = '';
  return stream;
}

function makeSandbox({ rootName = 'wakecron', rootInHome } = {}) {
  // Real path: on macOS the temp folder is under /var, a symlink to /private/var, and Node runs
  // the copied CLI from its real path, so an unresolved root would never match the CLI's own.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wakecron-test-')));
  sandboxes.push(dir);
  const home = path.join(dir, 'home');
  const root = rootInHome ? path.join(home, rootInHome) : path.join(dir, rootName);
  const bin = path.join(dir, 'bin');
  const fake = path.join(dir, 'fake');
  for (const d of [home, bin, fake, path.join(root, 'scripts')]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(REPO, 'lib'), path.join(root, 'lib'), { recursive: true });
  if (fs.existsSync(path.join(REPO, 'wakecron'))) {
    fs.copyFileSync(path.join(REPO, 'wakecron'), path.join(root, 'wakecron'));
    fs.chmodSync(path.join(root, 'wakecron'), 0o755);
  }
  for (const name of FAKE_NAMES) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TOOL}" ${name} "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }

  const env = { ...process.env, HOME: home, WAKECRON_BIN_DIR: bin, FAKE_STATE: fake };
  for (const key of ['FAKE_SUDO', 'FAKE_FAIL', 'FAKE_VIA_SUDO']) delete env[key];
  const readState = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(fake, name), 'utf8')); } catch { return fallback; }
  };
  const writeState = (name, value) => fs.writeFileSync(path.join(fake, name), JSON.stringify(value));

  return {
    root, home, bin, fake, env,
    writeScript(rel, content, mode = 0o755) {
      const abs = path.join(root, 'scripts', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      fs.chmodSync(abs, mode);
      return abs;
    },
    ctx(overrides = {}) {
      return createContext({ root, home, env, interactive: false, stdin: Readable.from([]), stdout: capture(), stderr: capture(), ...overrides });
    },
    io({ input = '', ...overrides } = {}) {
      return { root, home, env, interactive: false, stdin: Readable.from([input]), stdout: capture(), stderr: capture(), ...overrides };
    },
    runCli(args, { env: extra = {}, input = '' } = {}) {
      const r = spawnSync(process.execPath, [path.join(root, 'wakecron'), ...args], { env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 30000 });
      return { code: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    calls(tool) {
      let calls = [];
      try {
        calls = fs.readFileSync(path.join(fake, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch { /* no calls yet */ }
      return tool ? calls.filter((c) => c.tool === tool) : calls;
    },
    loaded: () => [...readState('loaded.json', [])].sort(),
    markLoaded(label) {
      writeState('loaded.json', [...new Set([...readState('loaded.json', []), label])]);
    },
    unload(label) {
      writeState('loaded.json', readState('loaded.json', []).filter((l) => l !== label));
    },
    wakes: () => [...readState('wakes.json', [])].sort(),
    seedWakes(entries) {
      writeState('wakes.json', entries.map((e) => (e.includes('|') ? e : `${e}|wakecron`)));
    },
    readJob(id) {
      try { return JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${id}.json`), 'utf8')); } catch { return null; }
    },
    agentFile: (label) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    waitFor(fn, ms = 3000) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          let ok = false;
          try { ok = fn(); } catch { ok = false; }
          if (ok) return resolve();
          if (Date.now() - start > ms) return reject(new Error('waitFor timed out'));
          return setTimeout(tick, 25);
        };
        tick();
      });
    },
  };
}

module.exports = { makeSandbox, capture };
