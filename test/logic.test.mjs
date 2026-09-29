/**
 * Pure-logic tests for dsh-quiet-hours: clock parsing, config validation,
 * window containment (including overnight and DST), resume-instant search, and
 * the wait loop driven by an injected clock.
 *
 * Run: node --test test/logic.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatClock,
  inPauseWindow,
  nextResumeAt,
  normalizeConfig,
  parseClock,
  waitUntilResume,
} from '../lib/index.js';

/** Epoch millis for a UTC wall-clock instant. */
const utc = (y, m, d, hh = 0, mm = 0, ss = 0) => Date.UTC(y, m - 1, d, hh, mm, ss);

/** The windows from the operator's peak-pricing table. */
const PEAK = {
  timezone: 'UTC',
  windows: [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '01:00', to: '04:00' },
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '06:00', to: '10:00' },
  ],
};

const cfg = (extra) => normalizeConfig({ ...PEAK, ...extra });

/* ------------------------------------------------------------ clock parse */

test('parseClock: accepts H:MM and HH:MM, rejects the rest', () => {
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('9:05'), 545);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('12:60'), null);
  assert.equal(parseClock('noon'), null);
  assert.equal(parseClock(undefined), null);
});

test('formatClock: round-trips', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(545), '09:05');
  assert.equal(formatClock(1439), '23:59');
});

/* --------------------------------------------------------------- config */

test('normalizeConfig: defaults to UTC with no windows', () => {
  const c = normalizeConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.timeZone, 'UTC');
  assert.deepEqual(c.windows, []);
  assert.equal(c.maxSleepChunkMs, 60000);
});

test('normalizeConfig: an unknown timezone is a loud failure, not a silent no-op', () => {
  assert.throws(() => normalizeConfig({ timezone: 'Mars/Olympus' }), /unknown timezone/);
});

test('normalizeConfig: malformed windows are rejected with the offending index', () => {
  assert.throws(() => normalizeConfig({ windows: [{ days: ['mon'], from: '01:00' }] }), /windows\[0\]\.from/);
  assert.throws(() => normalizeConfig({ windows: [{ days: ['funday'], from: '01:00', to: '02:00' }] }), /days/);
  assert.throws(() => normalizeConfig({ windows: [{ days: [], from: '01:00', to: '02:00' }] }), /days/);
  assert.throws(() => normalizeConfig({ windows: [{ days: ['mon'], from: '02:00', to: '02:00' }] }), /zero-length/);
  assert.throws(() => normalizeConfig({ windows: 'nope' }), /must be a list/);
});

test('normalizeConfig: accepts an overnight window and dedupes days', () => {
  const c = normalizeConfig({ windows: [{ days: ['mon', 'Mon', 'mon'], from: '22:00', to: '06:00' }] });
  assert.deepEqual(c.windows[0].days, ['mon']);
  assert.ok(c.windows[0].from > c.windows[0].to, 'overnight preserved');
});

/* ------------------------------------------------- containment in UTC */

test('inPauseWindow: inside, on the closing edge, and outside the peak windows', () => {
  const c = cfg();
  // 2026-09-25 is a Friday.
  assert.equal(inPauseWindow(utc(2026, 9, 25, 2, 0), c), true, 'inside 01:00-04:00');
  assert.equal(inPauseWindow(utc(2026, 9, 25, 1, 0), c), true, 'inclusive start');
  assert.equal(inPauseWindow(utc(2026, 9, 25, 3, 59), c), true, 'last minute');
  assert.equal(inPauseWindow(utc(2026, 9, 25, 4, 0), c), false, 'exclusive end');
  assert.equal(inPauseWindow(utc(2026, 9, 25, 5, 0), c), false, 'between windows');
  assert.equal(inPauseWindow(utc(2026, 9, 25, 6, 0), c), true, 'inside 06:00-10:00');
  assert.equal(inPauseWindow(utc(2026, 9, 25, 10, 0), c), false, 'exclusive end');
});

test('inPauseWindow: weekends are never paused', () => {
  const c = cfg();
  assert.equal(inPauseWindow(utc(2026, 9, 26, 2, 0), c), false, 'Saturday');
  assert.equal(inPauseWindow(utc(2026, 9, 27, 7, 0), c), false, 'Sunday');
});

test('inPauseWindow: a timezone shifts which instants land in the window', () => {
  // 03:00-06:00 local in Kyiv (UTC+3 in September) == 00:00-03:00 UTC.
  const c = normalizeConfig({
    timezone: 'Europe/Kyiv',
    windows: [{ days: ['fri'], from: '03:00', to: '06:00' }],
  });
  assert.equal(inPauseWindow(utc(2026, 9, 25, 1, 0), c), true, '01:00 UTC = 04:00 Kyiv');
  assert.equal(inPauseWindow(utc(2026, 9, 25, 0, 0), c), true, '00:00 UTC = 03:00 Kyiv');
  assert.equal(inPauseWindow(utc(2026, 9, 24, 23, 0), c), false, 'previous UTC day');
});

test('inPauseWindow: an overnight window belongs to the day it starts on', () => {
  const c = normalizeConfig({
    timezone: 'UTC',
    windows: [{ days: ['fri'], from: '22:00', to: '06:00' }],
  });
  assert.equal(inPauseWindow(utc(2026, 9, 25, 23, 0), c), true, 'Friday evening');
  assert.equal(inPauseWindow(utc(2026, 9, 26, 3, 0), c), true, 'Saturday small hours of Friday window');
  assert.equal(inPauseWindow(utc(2026, 9, 26, 6, 0), c), false, 'window closed');
  assert.equal(inPauseWindow(utc(2026, 9, 27, 3, 0), c), false, "Sunday small hours: Saturday owns no window");
});

/* ------------------------------------------------------- resume instant */

test('nextResumeAt: finds the closing boundary, minute-aligned', () => {
  const c = cfg();
  assert.equal(nextResumeAt(utc(2026, 9, 25, 2, 30, 15), c), utc(2026, 9, 25, 4, 0), 'mid first window');
  assert.equal(nextResumeAt(utc(2026, 9, 25, 9, 59, 59), c), utc(2026, 9, 25, 10, 0), 'last second of second window');
});

test('nextResumeAt: null when not paused', () => {
  const c = cfg();
  assert.equal(nextResumeAt(utc(2026, 9, 25, 5, 0), c), null);
  assert.equal(nextResumeAt(utc(2026, 9, 26, 5, 0), cfg()), null, 'Saturday');
});

test('nextResumeAt: an all-week window longer than the scan cap gives up (caller re-checks)', () => {
  const c = normalizeConfig({ windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '23:59' }], scanCapMs: 3_600_000 });
  assert.equal(nextResumeAt(utc(2026, 9, 25, 12, 0), c), null);
});

/* ------------------------------------------------------------ wait loop */

/** Drive `waitUntilResume` with a fake clock so hours pass instantly. */
function fakeClock(startMs) {
  const state = { now: startMs, sleeps: [] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

test('waitUntilResume: returns immediately when not paused', async () => {
  const c = cfg();
  const clock = fakeClock(utc(2026, 9, 25, 5, 0));
  const ended = await waitUntilResume(c, undefined, clock);
  assert.equal(ended, true);
  assert.equal(clock.state.sleeps.length, 0, 'no sleeping when outside a window');
});

test('waitUntilResume: parks through the window and wakes at the boundary', async () => {
  const c = cfg();
  const start = utc(2026, 9, 25, 2, 30);
  const clock = fakeClock(start);
  const ended = await waitUntilResume(c, undefined, clock);
  assert.equal(ended, true);
  assert.equal(clock.state.now, utc(2026, 9, 25, 4, 0), 'woke exactly at the window end');
  assert.ok(clock.state.sleeps.length >= 90, 'slept in bounded chunks, not one long timer');
  assert.ok(clock.state.sleeps.every((ms) => ms <= c.maxSleepChunkMs), 'every chunk is capped');
});

test('waitUntilResume: parks across both windows of the morning', async () => {
  const c = cfg();
  const clock = fakeClock(utc(2026, 9, 25, 6, 30));
  assert.equal(await waitUntilResume(c, undefined, clock), true);
  assert.equal(clock.state.now, utc(2026, 9, 25, 10, 0));
});

test('waitUntilResume: stops when the caller aborts while parked', async () => {
  const c = cfg();
  const clock = fakeClock(utc(2026, 9, 25, 2, 30));
  const controller = new AbortController();
  // Abort on the third wake-up, long before the window would end.
  let wake = 0;
  const ended = await waitUntilResume(c, undefined, {
    now: clock.now,
    sleep: async (ms) => {
      clock.state.now += ms;
      if (++wake === 3) controller.abort();
    },
    aborted: () => controller.signal.aborted,
  });
  assert.equal(ended, false, 'reports cancellation rather than a completed pause');
  assert.ok(clock.state.now < utc(2026, 9, 25, 4, 0), 'stopped early');
});

test('waitUntilResume: an already-aborted signal never parks', async () => {
  const c = cfg();
  const controller = new AbortController();
  controller.abort();
  const clock = fakeClock(utc(2026, 9, 25, 2, 30));
  assert.equal(await waitUntilResume(c, controller.signal, clock), false);
  assert.equal(clock.state.sleeps.length, 0);
});
