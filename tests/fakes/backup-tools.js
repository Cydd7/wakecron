'use strict';
// Stand-ins for the two tools scripts/morning/backup-shortcuts.js runs, so its tests work on any
// OS. Invoked as: node backup-tools.js <sqlite3|shortcuts> ...args (each test sandbox writes a
// tiny bin/ wrapper per tool). Every call is appended to $FAKE_LOG as a JSON array [tool, ...args].
//
// sqlite3:   ".backup "<dest>"" copies the library (the argument before it) to <dest>;
//            FAKE_SQLITE=fail-copy makes that fail. "PRAGMA quick_check;" prints $FAKE_CHECK or ok.
// shortcuts: "list" prints $FAKE_NAMES; FAKE_SHORTCUTS=fail makes it fail, =hang never exits.
const fs = require('node:fs');

const [tool, ...args] = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify([tool, ...args])}\n`);

const fail = (message, code) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

function sqlite3() {
  const backup = args.findIndex((arg) => arg.startsWith('.backup '));
  if (backup !== -1) {
    if (process.env.FAKE_SQLITE === 'fail-copy') fail('Error: disk I/O error', 1);
    const quoted = /^\.backup "((?:[^"\\]|\\.)*)"$/.exec(args[backup]);
    if (!quoted) fail(`fake sqlite3: can't parse ${args[backup]}`, 64);
    fs.copyFileSync(args[backup - 1], quoted[1].replace(/\\(.)/g, '$1'));
    return;
  }
  if (args.includes('PRAGMA quick_check;')) {
    process.stdout.write(`${process.env.FAKE_CHECK ?? 'ok'}\n`);
    return;
  }
  fail(`fake sqlite3: unsupported ${JSON.stringify(args)}`, 64);
}

function shortcuts() {
  if (args[0] !== 'list') fail(`fake shortcuts: unsupported ${JSON.stringify(args)}`, 64);
  if (process.env.FAKE_SHORTCUTS === 'fail') fail('Error: The operation couldn’t be completed.', 1);
  if (process.env.FAKE_SHORTCUTS === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(process.env.FAKE_NAMES ?? '');
}

if (tool === 'sqlite3') sqlite3();
else if (tool === 'shortcuts') shortcuts();
else fail(`backup-tools: unknown tool "${tool}"`, 64);
