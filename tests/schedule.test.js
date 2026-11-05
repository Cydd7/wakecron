'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/schedule');
const { UsageError } = require('../lib/util');

const d = (y, mo, day, h = 0, mi = 0, sec = 0, ms = 0) => new Date(y, mo - 1, day, h, mi, sec, ms);
const NOW = d(2026, 11, 5, 14, 29, 40); // Thu 05 Nov 2026 14:29:40
const daily = (hour, minute) => ({ type: 'repeat', hour, minute, days: s.ALL_DAYS });
const weekly = (days, hour = 7, minute = 30) => ({ type: 'repeat', hour, minute, days });

test('parseTimeOfDay accepts 24-hour and am/pm forms', () => {
  const cases = { '07:30': [7, 30], '7:30': [7, 30], '7:30pm': [19, 30], '7:30 PM': [19, 30], '7pm': [19, 0],
    '12am': [0, 0], '12pm': [12, 0], '00:00': [0, 0], '23:59': [23, 59], ' 07:30 ': [7, 30] };
  for (const [text, [hour, minute]] of Object.entries(cases)) assert.deepEqual(s.parseTimeOfDay(text), { hour, minute }, text);
});

test('parseTimeOfDay rejects bad times', () => {
  for (const bad of ['24:00', '07:60', '13pm', '0am', '7', 'abc', '']) assert.throws(() => s.parseTimeOfDay(bad), UsageError, bad);
  assert.throws(() => s.parseTimeOfDay('25:00'), { message: '"25:00" is not a valid time (try 07:30, 7:30pm or 7pm)' });
  assert.throws(() => s.parseTimeOfDay('07:30:15'), { message: '"07:30:15": seconds aren\'t supported (use HH:MM)' });
});

test('parseDays', () => {
  assert.deepEqual(s.parseDays('daily'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(s.parseDays('weekdays'), [1, 2, 3, 4, 5]);
  assert.deepEqual(s.parseDays('weekends'), [0, 6]);
  assert.deepEqual(s.parseDays('mon,wed,fri'), [1, 3, 5]);
  assert.deepEqual(s.parseDays('mon-fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(s.parseDays('fri-mon'), [0, 1, 5, 6]);
  assert.deepEqual(s.parseDays('Monday, TUES,thurs'), [1, 2, 4]);
  for (const bad of ['funday', 'mon-', '', 'mon--fri']) assert.throws(() => s.parseDays(bad), UsageError, bad);
  assert.throws(() => s.parseDays('funday'), { message: '"funday" is not a day (use mon..sun, weekdays, weekends or daily)' });
});

test('parseWhen: repeating, dated and relative forms', () => {
  assert.deepEqual(s.parseWhen('07:30', NOW), { type: 'repeat', hour: 7, minute: 30 });
  for (const text of ['2026-11-06 18:00', '2026-11-06T18:00', '2026-11-06 6pm', '2026-11-06   18:00'])
    assert.deepEqual(s.parseWhen(text, NOW), { type: 'once', at: '2026-11-06T18:00' }, text);
  assert.deepEqual(s.parseWhen('+10m', NOW), { type: 'once', at: '2026-11-05T14:40' }); // 14:39:40 rounded up
  assert.deepEqual(s.parseWhen('+2h', NOW), { type: 'once', at: '2026-11-05T16:30' });
  assert.deepEqual(s.parseWhen('+10m', d(2026, 11, 5, 14, 29)), { type: 'once', at: '2026-11-05T14:39' });
});

test('parseWhen rejects impossible, past and zero times', () => {
  assert.throws(() => s.parseWhen('2026-02-30 10:00', NOW), { message: '"2026-02-30" is not a real date' });
  assert.throws(() => s.parseWhen('2026-11-05 14:29', NOW), { message: '2026-11-05 14:29 is in the past' });
  assert.throws(() => s.parseWhen('+0m', NOW), { message: '"+0m": use at least +1m' });
  assert.throws(() => s.parseWhen('tomorrow', NOW), UsageError);
});

test('applyDays', () => {
  assert.deepEqual(s.applyDays({ type: 'repeat', hour: 7, minute: 30 }, undefined), daily(7, 30));
  assert.deepEqual(s.applyDays({ type: 'repeat', hour: 7, minute: 30 }, 'weekdays'), weekly([1, 2, 3, 4, 5]));
  const once = { type: 'once', at: '2026-11-06T18:00' };
  assert.deepEqual(s.applyDays(once, undefined), once);
  assert.throws(() => s.applyDays(once, 'mon'), { message: '--days only works with a repeating time like 07:30' });
});

test('nextRun is strictly after now and rolls over weeks, months and years', () => {
  assert.deepEqual(s.nextRun(daily(7, 30), NOW), d(2026, 11, 6, 7, 30));
  assert.deepEqual(s.nextRun(daily(15, 0), NOW), d(2026, 11, 5, 15, 0));
  assert.deepEqual(s.nextRun(weekly([1, 2, 3, 4, 5]), d(2026, 11, 6, 8, 0)), d(2026, 11, 9, 7, 30));
  assert.deepEqual(s.nextRun(weekly([1]), d(2026, 11, 9, 7, 30)), d(2026, 11, 16, 7, 30));
  assert.deepEqual(s.nextRun(daily(7, 30), d(2026, 11, 30, 8, 0)), d(2026, 12, 1, 7, 30));
  assert.deepEqual(s.nextRun(daily(7, 30), d(2026, 12, 31, 8, 0)), d(2027, 1, 1, 7, 30));
  assert.deepEqual(s.nextRun({ type: 'once', at: '2026-11-06T18:00' }, NOW), d(2026, 11, 6, 18, 0));
  assert.equal(s.nextRun({ type: 'once', at: '2026-11-05T14:00' }, NOW), null);
});

test('nextWake is 60 s early and skips runs whose wake is not 5 s ahead', () => {
  assert.deepEqual(s.nextWake(daily(7, 30), NOW), d(2026, 11, 6, 7, 29));
  assert.deepEqual(s.nextWake(daily(14, 30), NOW), d(2026, 11, 6, 14, 29));
  assert.deepEqual(s.nextWake(daily(14, 31), NOW), d(2026, 11, 5, 14, 30)); // review focus 5: 20 s ahead
  assert.deepEqual(s.nextWake(daily(14, 31), d(2026, 11, 5, 14, 29, 55)), d(2026, 11, 6, 14, 30));
  assert.deepEqual(s.nextWake(weekly([1]), d(2026, 11, 9, 7, 30, 0, 300)), d(2026, 11, 16, 7, 29));
  assert.deepEqual(s.nextWake({ type: 'once', at: '2026-11-05T14:31' }, NOW), d(2026, 11, 5, 14, 30));
  assert.equal(s.nextWake({ type: 'once', at: '2026-11-05T14:30' }, NOW), null);
});

test('calendarIntervals', () => {
  assert.deepEqual(s.calendarIntervals(daily(7, 30)), [{ Hour: 7, Minute: 30 }]);
  assert.deepEqual(s.calendarIntervals(weekly([1, 3, 5])), [1, 3, 5].map((Weekday) => ({ Weekday, Hour: 7, Minute: 30 })));
  assert.deepEqual(s.calendarIntervals({ type: 'once', at: '2026-11-06T18:00' }), [{ Month: 11, Day: 6, Hour: 18, Minute: 0 }]);
});

test('pmset dates round-trip', () => {
  assert.equal(s.formatPmsetDate(d(2026, 11, 6, 7, 29)), '11/06/26 07:29:00');
  assert.deepEqual(s.parsePmsetDate('11/06/26 07:29:00'), d(2026, 11, 6, 7, 29));
});

test('describeSchedule and display formats', () => {
  const at = (days) => s.describeSchedule(weekly(days));
  assert.equal(at([0, 1, 2, 3, 4, 5, 6]), 'daily 07:30');
  assert.equal(at([1, 2, 3, 4, 5]), 'weekdays 07:30');
  assert.equal(at([0, 6]), 'weekends 07:30');
  assert.equal(at([1, 2, 3, 4]), 'Mon-Thu 07:30');
  assert.equal(at([0, 5, 6]), 'Fri-Sun 07:30');
  assert.equal(at([1, 3, 5]), 'Mon,Wed,Fri 07:30');
  assert.equal(at([1, 2]), 'Mon,Tue 07:30');
  assert.equal(at([2]), 'Tue 07:30');
  assert.equal(s.describeSchedule({ type: 'once', at: '2026-11-06T18:00' }), 'once 2026-11-06 18:00');
  assert.equal(s.formatShort(d(2026, 11, 6, 7, 30)), 'Fri 06 Nov 07:30');
  assert.equal(s.formatStamp(d(2026, 11, 6, 7, 30, 5)), '2026-11-06 07:30:05');
});
