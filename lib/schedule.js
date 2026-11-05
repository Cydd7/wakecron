'use strict';
// Pure scheduling rules: parsing what the user types, working out the next run and the
// next wake-up, and formatting dates for pmset, launchd and people. `now` is always passed in.
const { UsageError } = require('./util');

const WAKE_LEAD_MS = 60000; // wake the Mac this long before a run
const WAKE_MIN_AHEAD_MS = 5000; // a wake must be at least this far in the future to schedule
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = Sunday, same numbering as Date#getDay and launchd

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const pad = (n) => String(n).padStart(2, '0');
const invalidTime = (text) => new UsageError(`"${text}" is not a valid time (try 07:30, 7:30pm or 7pm)`);

function parseTimeOfDay(text) {
  const t = String(text).trim();
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(t)) throw new UsageError(`"${t}": seconds aren't supported (use HH:MM)`);
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i.exec(t);
  if (ampm) {
    const hour12 = Number(ampm[1]);
    const minute = ampm[2] === undefined ? 0 : Number(ampm[2]);
    if (hour12 < 1 || hour12 > 12 || minute > 59) throw invalidTime(t);
    const pm = ampm[3].toLowerCase() === 'pm';
    return { hour: (hour12 % 12) + (pm ? 12 : 0), minute };
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) {
    const hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hour > 23 || minute > 59) throw invalidTime(t);
    return { hour, minute };
  }
  throw invalidTime(t);
}

function parseDays(text) {
  const whole = String(text).trim().toLowerCase();
  if (whole === 'daily') return [...ALL_DAYS];
  if (whole === 'weekdays') return [1, 2, 3, 4, 5];
  if (whole === 'weekends') return [0, 6];
  const days = new Set();
  for (const raw of String(text).split(',')) {
    const part = raw.trim();
    const notADay = new UsageError(`"${part}" is not a day (use mon..sun, weekdays, weekends or daily)`);
    const ends = part.split('-').map((name) => DAY_ALIASES[name.trim().toLowerCase()]);
    if (ends.length > 2 || ends.some((d) => d === undefined)) throw notADay;
    const [first, last = first] = ends;
    for (let d = first; ; d = (d + 1) % 7) { // ranges wrap past Saturday
      days.add(d);
      if (d === last) break;
    }
  }
  return [...days].sort((a, b) => a - b);
}

function localStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Parse what the user typed for "when": a repeating time of day, a dated one-time run, or +N m/h.
function parseWhen(text, now) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  const relative = /^\+(\d+)\s*([mh])$/i.exec(t);
  if (relative) {
    const amount = Number(relative[1]);
    if (amount < 1) throw new UsageError(`"${t}": use at least +1m`);
    const unit = relative[2].toLowerCase() === 'h' ? 3600000 : 60000;
    const at = new Date(now.getTime() + amount * unit);
    if (at.getSeconds() !== 0 || at.getMilliseconds() !== 0) {
      at.setSeconds(0, 0);
      at.setMinutes(at.getMinutes() + 1); // round up to the next whole minute
    }
    return { type: 'once', at: localStamp(at) };
  }
  const dated = /^(\d{4})-(\d{2})-(\d{2})[ T](.+)$/.exec(t);
  if (dated) {
    const [, ys, ms, ds, timeText] = dated;
    const [y, m, d] = [Number(ys), Number(ms), Number(ds)];
    const probe = new Date(y, m - 1, d);
    if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
      throw new UsageError(`"${ys}-${ms}-${ds}" is not a real date`);
    }
    const { hour, minute } = parseTimeOfDay(timeText);
    const at = `${ys}-${ms}-${ds}T${pad(hour)}:${pad(minute)}`;
    if (new Date(y, m - 1, d, hour, minute).getTime() <= now.getTime()) throw new UsageError(`${at.replace('T', ' ')} is in the past`);
    return { type: 'once', at };
  }
  const { hour, minute } = parseTimeOfDay(t);
  return { type: 'repeat', hour, minute };
}

function applyDays(partial, daysText) {
  if (partial.type === 'once') {
    if (daysText !== undefined) throw new UsageError('--days only works with a repeating time like 07:30');
    return partial;
  }
  const days = daysText === undefined ? [...ALL_DAYS] : parseDays(daysText);
  return { type: 'repeat', hour: partial.hour, minute: partial.minute, days };
}

function atParts(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(at));
  if (!m) throw new Error(`bad one-time date "${at}"`);
  return m.slice(1).map(Number); // [year, month, day, hour, minute]
}

function onceDate(schedule) {
  const [y, mo, d, h, mi] = atParts(schedule.at);
  return new Date(y, mo - 1, d, h, mi);
}

// Runs of a repeating schedule that are strictly after `now`, in order (two weeks is plenty).
function* repeatRuns(schedule, now) {
  for (let i = 0; i <= 14; i++) {
    const run = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, schedule.hour, schedule.minute, 0, 0);
    if (schedule.days.includes(run.getDay()) && run.getTime() > now.getTime()) yield run;
  }
}

function nextRun(schedule, now) {
  if (schedule.type === 'once') {
    const at = onceDate(schedule);
    return at.getTime() > now.getTime() ? at : null;
  }
  for (const run of repeatRuns(schedule, now)) return run;
  return null;
}

// The wake-up for the first run whose wake time (run - 60 s) is more than 5 s away. A run that is
// about to happen (the Mac is awake anyway) is skipped in favour of the one after it.
function nextWake(schedule, now) {
  const wakeFor = (run) => new Date(run.getTime() - WAKE_LEAD_MS);
  const farEnough = (run) => wakeFor(run).getTime() - now.getTime() > WAKE_MIN_AHEAD_MS;
  if (schedule.type === 'once') {
    const at = onceDate(schedule);
    return farEnough(at) ? wakeFor(at) : null;
  }
  for (const run of repeatRuns(schedule, now)) if (farEnough(run)) return wakeFor(run);
  return null;
}

function calendarIntervals(schedule) {
  if (schedule.type === 'once') {
    const [, Month, Day, Hour, Minute] = atParts(schedule.at); // launchd has no year field
    return [{ Month, Day, Hour, Minute }];
  }
  const { hour: Hour, minute: Minute } = schedule;
  if (schedule.days.length === 7) return [{ Hour, Minute }];
  return schedule.days.map((Weekday) => ({ Weekday, Hour, Minute }));
}

function formatPmsetDate(date) {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${pad(date.getFullYear() % 100)} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parsePmsetDate(text) {
  const m = /^(\d\d)\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(String(text));
  if (!m) return new Date(NaN);
  const [mo, d, y, h, mi, s] = m.slice(1).map(Number);
  return new Date(2000 + y, mo - 1, d, h, mi, s);
}

function describeDays(days) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const key = sorted.join(',');
  if (key === '0,1,2,3,4,5,6') return 'daily';
  if (key === '1,2,3,4,5') return 'weekdays';
  if (key === '0,6') return 'weekends';
  const mondayFirst = sorted.map((d) => (d === 0 ? 7 : d)).sort((a, b) => a - b);
  const runs = [];
  for (const d of mondayFirst) {
    const run = runs[runs.length - 1];
    if (run && d === run[run.length - 1] + 1) run.push(d);
    else runs.push([d]);
  }
  const name = (d) => DAY_NAMES[d % 7];
  return runs.flatMap((run) => (run.length >= 3 ? [`${name(run[0])}-${name(run[run.length - 1])}`] : run.map(name))).join(',');
}

function describeSchedule(schedule) {
  if (schedule.type === 'once') return `once ${schedule.at.replace('T', ' ')}`;
  return `${describeDays(schedule.days)} ${pad(schedule.hour)}:${pad(schedule.minute)}`;
}

function formatShort(date) {
  return `${DAY_NAMES[date.getDay()]} ${pad(date.getDate())} ${MONTH_NAMES[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = {
  WAKE_LEAD_MS, WAKE_MIN_AHEAD_MS, ALL_DAYS,
  parseTimeOfDay, parseDays, parseWhen, applyDays,
  onceDate, nextRun, nextWake, calendarIntervals,
  formatPmsetDate, parsePmsetDate, describeSchedule, formatShort, formatStamp,
};
