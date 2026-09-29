/**
 * Real-Cordis probe for dsh-quiet-hours.
 *
 * Boots a genuine cordis Context, mounts the plugin, and drives the
 * `llm/stream` waterfall exactly the way `LlmRuntime.stream()` does:
 *
 *   ctx.waterfall(thisArg, "llm/stream", options, () => adapterStream(options))
 *
 * The contract under test is the one that bites: the listener must return an
 * `AsyncIterable<StreamChunk>` *synchronously*, because the caller consumes the
 * return value without awaiting it. A promise here would break every model call.
 *
 * Run: node --test test/probe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { name, inject, apply } from '../lib/index.js';

let auditSeq = 0;
function auditPath() {
  auditSeq += 1;
  return path.join(os.tmpdir(), `quiet-hours-probe-${process.pid}-${auditSeq}.jsonl`);
}

/** Boot a real cordis Context with the plugin mounted. */
async function boot(config) {
  const ctx = new Context();
  await ctx.plugin({ name, inject, apply }, config);
  return ctx;
}

/** The adapter stream the fallback produces, marked so we can spot it. */
async function* adapterStream() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'adapter-ran' };
}

/** Drive the waterfall the way LlmRuntime.stream() does. */
function drive(ctx, options) {
  return ctx.waterfall({ stream: true }, 'llm/stream', options, () => adapterStream());
}

/** Drain an AsyncIterable into an array. */
async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/**
 * Read the audit trail once it holds at least `atLeast` complete lines.
 *
 * The plugin appends fire-and-forget, so a fixed sleep can read a half-written
 * line; a truncated line fails JSON.parse and the poll simply retries.
 */
async function readAuditLines(file, atLeast = 1, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text !== '') {
        const lines = text.split('\n').map((line) => JSON.parse(line));
        if (lines.length >= atLeast) return lines;
      }
    } catch {
      /* partial append: retry */
    }
    if (Date.now() > deadline) throw new Error(`audit file did not reach ${atLeast} complete line(s) within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A window covering *right now*, so the test does not depend on the wall clock.
 *
 * The window is 30 minutes wide, not one minute: a 1-minute window can expire
 * between building it and asserting on it, which makes the suite flaky exactly
 * once a minute.
 */
function windowCoveringNow() {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(now).toLowerCase().slice(0, 3);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const to = (minutes + 30) % 1440;
  // `to <= minutes` only when the window wraps past midnight, which
  // inPauseWindow already treats as an overnight window starting on `days`.
  return { timezone: 'UTC', windows: [{ days: [weekday], from: pad(minutes), to: pad(to) }] };
}

/** A window on every day except today, so it can never be active. */
function windowNotCoveringNow() {
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(now).toLowerCase().slice(0, 3);
  const others = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter((d) => d !== today);
  return { timezone: 'UTC', windows: [{ days: others, from: '00:00', to: '23:59' }] };
}

/* ------------------------------------------------------------------ *
 * pass-through
 * ------------------------------------------------------------------ */

test('probe: outside every window the call reaches the adapter untouched', async () => {
  const auditFile = auditPath();
  const ctx = await boot({ ...windowNotCoveringNow(), auditFile });
  const result = drive(ctx, { provider: 'p', model: 'm' });
  assert.equal(typeof result[Symbol.asyncIterator], 'function', 'still an AsyncIterable');
  assert.deepEqual((await collect(result)).at(-1), { type: 'text-delta', index: 0, text: 'adapter-ran' });
  assert.equal(fs.existsSync(auditFile), false, 'no audit line when nothing was parked');
});

test('probe: an empty window list is inert', async () => {
  const ctx = await boot({ windows: [] });
  const result = drive(ctx, {});
  assert.deepEqual((await collect(result)).at(-1), { type: 'text-delta', index: 0, text: 'adapter-ran' });
});

test('probe: enabled:false is inert even inside a window', async () => {
  const ctx = await boot({ ...windowCoveringNow(), enabled: false });
  const result = drive(ctx, {});
  assert.deepEqual((await collect(result)).at(-1), { type: 'text-delta', index: 0, text: 'adapter-ran' });
});

/* ------------------------------------------------------------------ *
 * parking
 * ------------------------------------------------------------------ */

test('probe: inside a window the listener returns an AsyncIterable, NOT a promise', async () => {
  const auditFile = auditPath();
  const ctx = await boot({ ...windowCoveringNow(), auditFile });
  const controller = new AbortController();
  const result = drive(ctx, { provider: 'example-provider', model: 'example-model', signal: controller.signal });

  // The contract that matters: a thenable here would break every model call.
  assert.equal(typeof result.then, 'undefined', 'must not be a promise');
  assert.equal(typeof result[Symbol.asyncIterator], 'function', 'must be an AsyncIterable');
  assert.ok(result instanceof Object);

  // The pause is recorded as soon as the gate trips, before the call starts.
  const parked = await readAuditLines(auditFile);
  assert.equal(parked.at(-1).event, 'pause');
  assert.equal(parked.at(-1).provider, 'example-provider');
  assert.ok(parked.at(-1).resumeAt > Date.now() - 60_000, 'resume instant is in the future');

  // Release it so the test does not sit on a parked timer.
  controller.abort();
  assert.deepEqual((await collect(result)).at(-1), { type: 'text-delta', index: 0, text: 'adapter-ran' });
});

test('probe: an aborted parked call is released to the adapter and logged as cancelled', async () => {
  const auditFile = auditPath();
  const ctx = await boot({ ...windowCoveringNow(), auditFile });
  const controller = new AbortController();
  controller.abort();
  const result = drive(ctx, { provider: 'p', model: 'm', signal: controller.signal });
  assert.deepEqual((await collect(result)).at(-1), { type: 'text-delta', index: 0, text: 'adapter-ran' });

  const events = await readAuditLines(auditFile, 2);
  assert.deepEqual(events.map((e) => e.event), ['pause', 'cancelled']);
});

test('probe: unloading the plugin removes the gate', async () => {
  const ctx = await boot({ ...windowCoveringNow() });
  assert.equal(typeof drive(ctx, {}).then, 'undefined', 'parked while mounted');
  await ctx.fiber.dispose();
  const after = drive(ctx, {});
  assert.deepEqual((await collect(after)).at(-1), { type: 'text-delta', index: 0, text: 'adapter-ran' });
});

/* ------------------------------------------------------------------ *
 * config failures stay loud
 * ------------------------------------------------------------------ */

test('probe: an invalid timezone fails the mount instead of silently never pausing', async () => {
  const ctx = new Context();
  // `ctx.plugin` returns a thenable fiber (not a Promise instance), so awaiting
  // it through a wrapper is what surfaces the mount failure.
  await assert.rejects(
    async () => {
      await ctx.plugin({ name, inject, apply }, { timezone: 'Mars/Olympus' });
    },
    /unknown timezone/,
  );
  const after = drive(ctx, {});
  assert.deepEqual((await collect(after)).at(-1), { type: 'text-delta', index: 0, text: 'adapter-ran' }, 'no gate was installed');
});
