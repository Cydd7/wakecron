'use strict';
// The real sqlite3, made to act like the one on macOS: there, a read-only connection won't create
// the -shm file that reading a WAL-mode database needs. So it can read the Shortcuts library,
// which the Shortcuts app keeps open (its -shm exists), but not a fresh copy of it: "unable to open
// database file (14)". SQLite's readonly_shm=1 URI parameter gives the same behaviour anywhere.
// Invoked as: node mac-sqlite3.js <path of the real sqlite3> ...args
const { spawnSync } = require('node:child_process');

const [real, ...args] = process.argv.slice(2);
const TAKES_VALUE = new Set(['-init', '-cmd']);

if (args.includes('-readonly')) {
  // The database is the first argument that is neither an option nor an option's value.
  const at = args.findIndex((arg, i) => !arg.startsWith('-') && !TAKES_VALUE.has(args[i - 1]));
  if (at !== -1) {
    const db = args[at];
    args[at] = db.startsWith('file:')
      ? `${db}${db.includes('?') ? '&' : '?'}readonly_shm=1`
      : `file:${db.replace(/[%?#]/g, (c) => encodeURIComponent(c))}?readonly_shm=1`;
  }
}

const result = spawnSync(real, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
