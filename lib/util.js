'use strict';
// Small shared helpers: the usage-error type (exit code 2) and safe file writes.
const fs = require('node:fs');
const path = require('node:path');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Write to a temp file in the same folder, then rename, so readers never see half a file.
function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { UsageError, ensureDir, writeFileAtomic };
