'use strict';
// The sudoers rule `setup` installs: it lets one user run exactly two pmset commands without a
// password — schedule a wake-up and cancel one — for any date, with the "wakecron" owner tag.
// The date is matched digit by digit (no `*`), so nothing else about pmset can be changed.
const { UsageError } = require('./util');

const OWNER = 'wakecron';
const DATE_PATTERN = '[0-9][0-9]/[0-9][0-9]/[0-9][0-9] [0-9][0-9]\\:[0-9][0-9]\\:[0-9][0-9]';
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function validateUsername(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name)) {
    throw new UsageError(`"${name}" can't be used in a sudoers rule`);
  }
}

// sudo ignores files in sudoers.d whose names contain a dot, so map anything unusual to "_".
function sudoersFileName(user) {
  return `wakecron_${String(user).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function sudoersRule({ user, pmsetPath = '/usr/bin/pmset' }) {
  validateUsername(user);
  return [
    `# wakecron: lets ${user} schedule and cancel wake-ups without a password.`,
    '# Installed by "wakecron setup"; removed by "wakecron uninstall".',
    `${user} ALL = (root) NOPASSWD: \\`,
    `  ${pmsetPath} schedule wake ${DATE_PATTERN} ${OWNER}, \\`,
    `  ${pmsetPath} schedule cancel wake ${DATE_PATTERN} ${OWNER}`,
    '',
  ].join('\n');
}

module.exports = { sudoersRule, validateUsername, sudoersFileName };
