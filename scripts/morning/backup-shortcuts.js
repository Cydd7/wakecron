#!/usr/bin/env node
'use strict';
// Backs up the Apple Shortcuts library into daily, weekly and monthly copies.
// A step of scripts/morning.sh. Design: docs/superpowers/specs/2026-11-06-morning-routine-design.md

const KINDS = ['daily', 'weekly', 'monthly'];
const DATED = /^\d{4}-\d{2}-\d{2}$/;

// ---- Dates (pure) -------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

// The local calendar date of `date`, as YYYY-MM-DD.
function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Calendar arithmetic on YYYY-MM-DD strings, done in UTC so time zones and DST can't shift it.
function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const formatDay = (date) => date.toISOString().slice(0, 10);

function addDays(day, n) {
  const date = parseDay(day);
  date.setUTCDate(date.getUTCDate() + n);
  return formatDay(date);
}

// The Monday on or before `day`; weeks run Monday to Sunday.
function mondayOf(day) {
  return addDays(day, -((parseDay(day).getUTCDay() + 6) % 7));
}

// ---- Rotation (pure) ----------------------------------------------------------------------

// Decides what one run does, given today's date and the folder names already in daily/,
// weekly/ and monthly/. Only YYYY-MM-DD names count; anything else is never counted or pruned.
function planRotation({ today, existing, keep }) {
  const dated = {};
  for (const kind of KINDS) dated[kind] = existing[kind].filter((name) => DATED.test(name));

  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  const weekly = !dated.weekly.some((d) => d >= monday && d <= sunday);
  const monthly = !dated.monthly.some((d) => d.startsWith(today.slice(0, 7)));

  const after = {
    daily: [...dated.daily, today],
    weekly: weekly ? [...dated.weekly, today] : dated.weekly,
    monthly: monthly ? [...dated.monthly, today] : dated.monthly,
  };
  const prune = {};
  for (const kind of KINDS) {
    const newestFirst = [...new Set(after[kind])].sort().reverse();
    prune[kind] = newestFirst.slice(keep[kind]).sort();
  }
  return { replaceDaily: dated.daily.includes(today), weekly, monthly, prune };
}

module.exports = { localDate, mondayOf, planRotation };
