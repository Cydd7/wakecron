'use strict';
// The job store (one JSON file per job in jobs/), job ids, and finding scripts in scripts/.
const fs = require('node:fs');
const path = require('node:path');
const { UsageError, writeFileAtomic } = require('./util');
const { jobFile } = require('./paths');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const pad = (n) => String(n).padStart(2, '0');

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id) && id !== 'sync';
}

function slugify(scriptRel) {
  const name = path.parse(String(scriptRel)).name.toLowerCase();
  const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  return slug || 'job';
}

function hhmm(schedule) {
  if (schedule.type === 'once') return schedule.at.slice(11, 13) + schedule.at.slice(14, 16);
  return pad(schedule.hour) + pad(schedule.minute);
}

function makeJobId(scriptRel, schedule, existingIds) {
  const base = `${slugify(scriptRel)}-${hhmm(schedule)}`;
  if (!existingIds.has(base)) return base;
  for (let n = 2; ; n++) if (!existingIds.has(`${base}-${n}`)) return `${base}-${n}`;
}

function problemWith(job, id) {
  if (!job || typeof job !== 'object') return 'not a JSON object';
  if (job.id !== id) return "its id doesn't match the file name";
  if (typeof job.script !== 'string') return 'missing "script"';
  if (!job.schedule || !['repeat', 'once'].includes(job.schedule.type)) return 'missing or unknown "schedule"';
  return null;
}

// null when the file doesn't exist, { error } when it can't be used, otherwise { job }.
function loadJobFile(ctx, id) {
  let text;
  try {
    text = fs.readFileSync(jobFile(ctx, id), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { error: e.message };
  }
  let job;
  try {
    job = JSON.parse(text);
  } catch (e) {
    return { error: e.message };
  }
  const problem = problemWith(job, id);
  return problem ? { error: problem } : { job };
}

function listJobs(ctx) {
  let names;
  try {
    names = fs.readdirSync(ctx.paths.jobsDir);
  } catch {
    return { jobs: [], invalid: [] };
  }
  const jobs = [];
  const invalid = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const loaded = loadJobFile(ctx, name.slice(0, -'.json'.length));
    if (!loaded) continue;
    if (loaded.error) invalid.push({ file: `jobs/${name}`, error: loaded.error });
    else jobs.push(loaded.job);
  }
  return { jobs, invalid };
}

function readJob(ctx, id) {
  const loaded = loadJobFile(ctx, id);
  if (!loaded) return null;
  if (loaded.error) throw new Error(`invalid job file jobs/${id}.json: ${loaded.error}`);
  return loaded.job;
}

function writeJob(ctx, job) {
  writeFileAtomic(jobFile(ctx, job.id), `${JSON.stringify(job, null, 2)}\n`);
}

function deleteJob(ctx, id) {
  try {
    fs.unlinkSync(jobFile(ctx, id));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

function resolveScript(ctx, name) {
  const dir = ctx.paths.scriptsDir;
  const abs = path.resolve(dir, String(name));
  const rel = path.relative(dir, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new UsageError(`scripts must be inside scripts/ ("${name}")`);
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new UsageError(`no script "${name}" in scripts/`);
  }
  if (!stat.isFile()) throw new UsageError(`"${name}" is not a file`);
  return { rel: rel.split(path.sep).join('/'), abs };
}

function listScripts(ctx) {
  const found = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() || (entry.isSymbolicLink() && fs.statSync(abs, { throwIfNoEntry: false })?.isFile())) found.push(rel);
    }
  };
  walk(ctx.paths.scriptsDir, '');
  return found.sort();
}

function scriptInfo(abs) {
  const head = Buffer.alloc(2);
  const fd = fs.openSync(abs, 'r');
  let read;
  try {
    read = fs.readSync(fd, head, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { hasShebang: read === 2 && head.toString('latin1') === '#!', executable: (fs.statSync(abs).mode & 0o100) !== 0 };
}

function ensureExecutable(abs) {
  const { mode } = fs.statSync(abs);
  if (mode & 0o100) return false;
  fs.chmodSync(abs, (mode & 0o7777) | 0o100);
  return true;
}

function sameSchedule(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'once') return a.at === b.at;
  const days = (s) => [...s.days].sort((x, y) => x - y).join(',');
  return a.hour === b.hour && a.minute === b.minute && days(a) === days(b);
}

module.exports = {
  isValidId, slugify, makeJobId, listJobs, readJob, writeJob, deleteJob,
  resolveScript, listScripts, scriptInfo, ensureExecutable, sameSchedule,
};
