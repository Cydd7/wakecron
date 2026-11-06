'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { localDate, mondayOf, planRotation } = require('../scripts/morning/backup-shortcuts');

const KEEP = { daily: 7, weekly: 4, monthly: 12 };
const none = { daily: [], weekly: [], monthly: [] };
const withTZ = (tz, fn) => {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
};

test('localDate is the local calendar date', () => {
  assert.equal(localDate(new Date(2026, 10, 6, 7, 0)), '2026-11-06');
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  withTZ('America/New_York', () => {
    assert.equal(localDate(new Date('2026-11-01T04:30:00Z')), '2026-11-01'); // the night US DST ends
    assert.equal(localDate(new Date('2026-11-01T03:30:00Z')), '2026-10-31');
  });
});

test('mondayOf finds the Monday that starts the week, in any time zone', () => {
  for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney']) {
    withTZ(tz, () => {
      assert.equal(mondayOf('2026-11-06'), '2026-11-02'); // Friday
      assert.equal(mondayOf('2026-11-02'), '2026-11-02'); // Monday
      assert.equal(mondayOf('2026-11-08'), '2026-11-02'); // Sunday
      assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // US DST ends
      assert.equal(mondayOf('2026-10-25'), '2026-10-19'); // EU DST ends
      assert.equal(mondayOf('2027-01-01'), '2026-12-28');
    });
  }
});

test('the first run ever makes a daily, a weekly and a monthly backup', () => {
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: none, keep: KEEP }),
    { replaceDaily: false, weekly: true, monthly: true, prune: { daily: [], weekly: [], monthly: [] } });
});

test('later days in the same week and month make only a daily backup', () => {
  const existing = { daily: ['2026-11-06'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  const plan = planRotation({ today: '2026-11-08', existing, keep: KEEP });
  assert.equal(plan.replaceDaily, false);
  assert.equal(plan.weekly, false);
  assert.equal(plan.monthly, false);
});

test('Monday starts a new week', () => {
  const existing = { daily: ['2026-11-08'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  assert.equal(planRotation({ today: '2026-11-09', existing, keep: KEEP }).weekly, true);
});

test('a new month gets a monthly backup; the week keeps its earlier weekly', () => {
  const existing = { daily: ['2026-11-30'], weekly: ['2026-11-30'], monthly: ['2026-11-06'] };
  const plan = planRotation({ today: '2026-12-01', existing, keep: KEEP });
  assert.equal(plan.monthly, true);
  assert.equal(plan.weekly, false);
});

test('a week that spans New Year is one week', () => {
  const existing = { daily: ['2026-12-31'], weekly: ['2026-12-28'], monthly: ['2026-12-01'] };
  const plan = planRotation({ today: '2027-01-01', existing, keep: KEEP });
  assert.equal(plan.weekly, false);
  assert.equal(plan.monthly, true);
});

test('a second run on the same day replaces the daily backup only', () => {
  const existing = { daily: ['2026-11-06'], weekly: ['2026-11-06'], monthly: ['2026-11-06'] };
  assert.deepEqual(planRotation({ today: '2026-11-06', existing, keep: KEEP }),
    { replaceDaily: true, weekly: false, monthly: false, prune: { daily: [], weekly: [], monthly: [] } });
});

test('pruning keeps the newest N by count', () => {
  const daily = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: { ...none, daily }, keep: KEEP }).prune.daily, ['2026-10-28', '2026-10-29']);
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: { ...none, daily: daily.slice(-3) }, keep: KEEP }).prune.daily, []);
});

test("names it didn't create are never counted or pruned", () => {
  const daily = ['notes.txt', '2026-11-06-old', '.incoming-x', 'before-restore-20261101-120000', '2026-11-01', '2026-11-02'];
  assert.deepEqual(planRotation({ today: '2026-11-06', existing: { ...none, daily }, keep: { ...KEEP, daily: 1 } }).prune.daily,
    ['2026-11-01', '2026-11-02']);
});

test('lowering a count prunes down to it', () => {
  const daily = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  assert.deepEqual(planRotation({ today: '2026-11-08', existing: { ...none, daily }, keep: { ...KEEP, daily: 3 } }).prune.daily,
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
});

test('a year of daily runs ends with 7 daily, 4 weekly and 12 monthly backups', () => {
  const state = { daily: [], weekly: [], monthly: [] };
  const day = new Date(Date.UTC(2026, 10, 6));
  let today;
  for (let i = 0; i < 400; i += 1, day.setUTCDate(day.getUTCDate() + 1)) {
    today = day.toISOString().slice(0, 10);
    const plan = planRotation({ today, existing: state, keep: KEEP });
    if (!plan.replaceDaily) state.daily.push(today);
    if (plan.weekly) state.weekly.push(today);
    if (plan.monthly) state.monthly.push(today);
    for (const kind of ['daily', 'weekly', 'monthly']) state[kind] = state[kind].filter((d) => !plan.prune[kind].includes(d));
  }
  assert.equal(today, '2027-12-10');
  assert.deepEqual(state.daily, ['2027-12-04', '2027-12-05', '2027-12-06', '2027-12-07', '2027-12-08', '2027-12-09', '2027-12-10']);
  assert.deepEqual(state.weekly, ['2027-11-15', '2027-11-22', '2027-11-29', '2027-12-06']);
  assert.deepEqual(state.monthly, Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}-01`));
});
