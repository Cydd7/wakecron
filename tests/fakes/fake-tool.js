'use strict';
// One stand-in for every macOS tool wakecron calls, so the whole program can be tested on any OS.
// Invoked as: node fake-tool.js <tool> ...args (tests/helpers.js writes a tiny wrapper per tool).
//
// Every call is appended to $FAKE_STATE/calls.jsonl as {tool, args, viaSudo, content?} before it
// acts. Loaded agents live in loaded.json and scheduled wake-ups in wakes.json ("date|owner").
// FAKE_FAIL="tool" or "tool:<first arg>" (comma list) makes a call print "fake failure" and exit 1.
// FAKE_SUDO=deny makes `sudo -n` behave as if a password were required. FAKE_SUDO=cached models
// credentials cached by a recent sudo while the wakecron rule is NOT active: `sudo -n` works, but
// `sudo -n -k` (which ignores cached credentials) needs a password.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [tool, ...args] = process.argv.slice(2);
const stateDir = process.env.FAKE_STATE;
if (!stateDir) {
  process.stderr.write('fake-tool: FAKE_STATE is not set\n');
  process.exit(99);
}

const stateFile = (name) => path.join(stateDir, name);
const readState = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(stateFile(name), 'utf8')); } catch { return fallback; }
};
const writeState = (name, value) => fs.writeFileSync(stateFile(name), JSON.stringify(value));
const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};
const out = (text) => process.stdout.write(text);
const fail = (text, code) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};

const viaSudo = process.env.FAKE_VIA_SUDO === '1';
const record = { tool, args, viaSudo };
if (tool === 'visudo' && args[0] === '-cf') record.content = readText(args[1]);
if (tool === 'install' && args.length >= 2) record.content = readText(args[args.length - 2]);
fs.appendFileSync(stateFile('calls.jsonl'), `${JSON.stringify(record)}\n`);

const injected = (process.env.FAKE_FAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
if (injected.includes(tool) || injected.includes(`${tool}:${args[0]}`)) fail('fake failure', 1);

function launchctl() {
  const loaded = new Set(readState('loaded.json', []));
  const [sub, target, plist] = args;
  if (sub === 'bootstrap') {
    const text = readText(plist);
    if (text === null) fail('Bootstrap failed: 2: No such file or directory', 2);
    const match = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    if (!match || loaded.has(match[1])) fail('Bootstrap failed: 5: Input/output error', 5);
    loaded.add(match[1]);
    writeState('loaded.json', [...loaded]);
    return 0;
  }
  const label = String(target).split('/').slice(2).join('/'); // gui/<uid>/<label>
  if (sub === 'print') {
    if (!loaded.has(label)) fail(`Could not find service "${label}" in domain for user gui`, 113);
    out(`${target} = {\n\tstate = waiting\n}\n`);
    return 0;
  }
  if (sub === 'bootout') {
    if (!loaded.has(label)) fail('Boot-out failed: 3: No such process', 3);
    loaded.delete(label);
    writeState('loaded.json', [...loaded]);
    return 0;
  }
  return fail(`fake launchctl: unsupported "${sub}"`, 64);
}

function pmset() {
  const wakes = readState('wakes.json', []);
  if (args[0] === '-g' && args[1] === 'sched') {
    if (wakes.length === 0) {
      out('No scheduled events.\n');
      return 0;
    }
    out('Scheduled power events:\n');
    wakes.forEach((entry, i) => {
      const [date, owner] = entry.split('|');
      const [day, time] = date.split(' ');
      const [mo, d, yy] = day.split('/');
      out(` [${i}]  wake at ${mo}/${d}/20${yy} ${time} by '${owner}'\n`);
    });
    return 0;
  }
  if (args[0] === 'schedule') {
    if (!viaSudo) fail('pmset: this command must be run as root', 1);
    const cancel = args[1] === 'cancel';
    const [type, date, owner = ''] = args.slice(cancel ? 2 : 1);
    if (type !== 'wake' || !/^\d\d\/\d\d\/\d\d \d\d:\d\d:\d\d$/.test(date || '')) fail('pmset: bad schedule arguments', 1);
    const entry = `${date}|${owner}`;
    if (cancel) {
      const i = wakes.indexOf(entry);
      if (i < 0) fail('unable to cancel', 1);
      wakes.splice(i, 1);
    } else {
      wakes.push(entry);
    }
    writeState('wakes.json', wakes);
    return 0;
  }
  return fail('fake pmset: unsupported arguments', 64);
}

function sudo() {
  let i = 0;
  let nonInteractive = false;
  let list = false;
  let ignoreCached = false;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '-n') nonInteractive = true;
    if (args[i] === '-l') list = true;
    if (args[i] === '-k') ignoreCached = true;
  }
  const command = args.slice(i);
  const mode = process.env.FAKE_SUDO;
  if (nonInteractive && (mode === 'deny' || (mode === 'cached' && ignoreCached))) fail('sudo: a password is required', 1);
  if (list) {
    out(`${command.join(' ')}\n`);
    return 0;
  }
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, FAKE_VIA_SUDO: '1' } });
  return r.status === null ? 1 : r.status;
}

function caffeinate() {
  const w = args.indexOf('-w');
  if (w < 0) return 0;
  const pid = Number(args[w + 1]);
  const deadline = Date.now() + 30000;
  const timer = setInterval(() => {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive || Date.now() > deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 50);
  return null; // keep running until the pid is gone
}

const handlers = { launchctl, pmset, sudo, caffeinate };
const code = handlers[tool] ? handlers[tool]() : 0; // visudo, install, rm, osascript: record only
if (code !== null) process.exit(code);
