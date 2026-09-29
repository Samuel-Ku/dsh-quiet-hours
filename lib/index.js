/**
 * dsh-quiet-hours — hold every model call until a configured pause window ends.
 *
 * The hook is the `llm/stream` waterfall, which wraps *every* streaming model
 * call in the process (`@deepseek-ai/dsh-llm`: "Waterfall around every streaming
 * model call (retry, replay, routing)"). During a pause window the listener
 * returns an async generator that does not start the underlying request until
 * the window is over, so an in-flight task parks itself at the next model call
 * and continues from exactly the same place once the window ends. No tokens are
 * spent while parked.
 *
 * Note the waterfall's contract: the listener must return an
 * `AsyncIterable<StreamChunk>` **synchronously** — the caller does not await it.
 * That is why the wait lives inside the generator body rather than in the
 * listener itself.
 *
 * Tools are deliberately not gated. They cost no tokens, and the model call that
 * would consume their output is parked anyway, so gating them would only risk
 * interrupting a half-finished side effect.
 *
 * Windows are wall-clock intervals in an IANA timezone, evaluated with `Intl`,
 * so DST is handled by the platform rather than by offset arithmetic. A window
 * with `from > to` spans midnight and belongs to the day it starts on.
 *
 * Pure JavaScript (ESM); host code imports only node: builtins and the cordis
 * peer.
 *
 * @module dsh-quiet-hours
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Cordis plugin name. */
export const name = 'dsh-quiet-hours';

/** No services are required: the plugin only observes the clock. */
export const inject = [];

/** Canonical weekday keys, in `Intl` 'en-GB' short form (lowercased). */
export const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/** Cache of `Intl.DateTimeFormat` instances per timezone (they are expensive). */
const FORMATTERS = new Map();

/** Build (and cache) the wall-clock formatter for one timezone. */
function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Wall-clock facts for one instant in one timezone.
 * @param {Date} date the instant
 * @param {string} timeZone IANA zone
 * @returns {{weekday: string, minutes: number, year: number, month: number, day: number}}
 */
function wallClock(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) parts[type] = value;
  const weekday = String(parts.weekday).toLowerCase().slice(0, 3);
  return {
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

/**
 * Weekday key of the calendar day *before* the one described by `local`.
 *
 * The local calendar date is re-read as a UTC noon, stepped back one day, and
 * re-formatted — so this is calendar arithmetic, never offset arithmetic, and
 * stays correct across DST changes.
 * @param {{year: number, month: number, day: number}} local wall-clock date
 * @param {string} timeZone IANA zone
 * @returns {string} weekday key
 */
function previousWeekday(local, timeZone) {
  const noonUtc = Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0);
  return wallClock(new Date(noonUtc - 86_400_000), timeZone).weekday;
}

/** Parse `HH:MM` (or `H:MM`) into minutes past local midnight; null when invalid. */
export function parseClock(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Render minutes past midnight back to `HH:MM`. */
export function formatClock(minutes) {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Normalize one day token to a weekday key; null when unrecognized. */
function normalizeDay(token) {
  if (typeof token !== 'string') return null;
  const key = token.trim().toLowerCase().slice(0, 3);
  return WEEKDAYS.includes(key) ? key : null;
}

/**
 * Normalize and validate the plugin row config. Throws on a malformed window or
 * an unknown timezone — a pause schedule that silently does nothing is worse
 * than a load failure that says why.
 * @param {object} [raw] plugin row config
 * @returns {Readonly<object>} normalized config
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const timeZone = typeof c.timezone === 'string' && c.timezone.trim() !== '' ? c.timezone.trim() : 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    throw new Error(`quiet-hours: unknown timezone ${JSON.stringify(timeZone)} (use an IANA name such as "UTC" or "Europe/Kyiv")`);
  }
  if (c.windows !== undefined && !Array.isArray(c.windows)) {
    throw new Error('quiet-hours: windows must be a list');
  }
  const windows = (c.windows ?? []).map((entry, index) => {
    const where = `windows[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`quiet-hours: ${where} must be a mapping`);
    const days = Array.isArray(entry.days) ? entry.days.map(normalizeDay) : null;
    if (days === null || days.length === 0 || days.some((d) => d === null)) {
      throw new Error(`quiet-hours: ${where}.days must list weekday names (mon..sun)`);
    }
    const from = parseClock(entry.from);
    const to = parseClock(entry.to);
    if (from === null || to === null) throw new Error(`quiet-hours: ${where}.from/.to must be "HH:MM"`);
    if (from === to) throw new Error(`quiet-hours: ${where} has a zero-length window (from === to)`);
    return Object.freeze({ days: Object.freeze([...new Set(days)]), from, to });
  });
  return Object.freeze({
    enabled: c.enabled !== false,
    timeZone,
    windows: Object.freeze(windows),
    maxSleepChunkMs: Number.isInteger(c.maxSleepChunkMs) && c.maxSleepChunkMs > 0 ? c.maxSleepChunkMs : 60_000,
    scanCapMs: Number.isInteger(c.scanCapMs) && c.scanCapMs > 0 ? c.scanCapMs : 21 * 86_400_000,
    auditFile:
      typeof c.auditFile === 'string' && c.auditFile.trim() !== ''
        ? c.auditFile.trim()
        : path.join(os.homedir(), '.dsh', 'logs', 'quiet-hours.jsonl'),
  });
}

/**
 * Whether one instant falls inside any configured pause window.
 * @param {number} now epoch milliseconds
 * @param {object} config normalized config
 * @returns {boolean} true when the plugin should park
 */
export function inPauseWindow(now, config) {
  if (!config.enabled || config.windows.length === 0) return false;
  const local = wallClock(new Date(now), config.timeZone);
  const prev = previousWeekday(local, config.timeZone);
  for (const window of config.windows) {
    if (window.from < window.to) {
      if (window.days.includes(local.weekday) && local.minutes >= window.from && local.minutes < window.to) return true;
      continue;
    }
    // Spans midnight: the early-morning part belongs to the previous day's window.
    if (window.days.includes(local.weekday) && local.minutes >= window.from) return true;
    if (window.days.includes(prev) && local.minutes < window.to) return true;
  }
  return false;
}

/**
 * First minute boundary at or after `now` that is outside every pause window.
 *
 * Scans forward on a minute grid rather than doing offset arithmetic, so a
 * window that ends across a DST jump still resolves to the right instant.
 * @param {number} now epoch milliseconds
 * @param {object} config normalized config
 * @returns {number|null} resume instant, or null when still paused past the scan cap
 */
export function nextResumeAt(now, config) {
  if (!inPauseWindow(now, config)) return null;
  const step = 60_000;
  const limit = now + config.scanCapMs;
  let candidate = Math.floor(now / step) * step + step;
  while (candidate <= limit) {
    if (!inPauseWindow(candidate, config)) return candidate;
    candidate += step;
  }
  return null;
}

/** Sleep that resolves early (without throwing) when the signal aborts. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    }
    if (signal) signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Block until the pause window is over, re-checking on a bounded cadence so a
 * clock jump or an abort is noticed promptly.
 * @param {object} config normalized config
 * @param {AbortSignal} [signal] upstream cancellation
 * @param {object} [seams] test seams: `now()` clock, `sleep(ms, signal)`, `aborted()`
 * @returns {Promise<boolean>} true when the pause actually ended, false when aborted
 */
export async function waitUntilResume(config, signal, seams = {}) {
  const now = seams.now ?? (() => Date.now());
  const sleepFn = seams.sleep ?? sleep;
  const aborted = seams.aborted ?? (() => Boolean(signal && signal.aborted));
  for (;;) {
    if (aborted()) return false;
    const at = now();
    if (!inPauseWindow(at, config)) return true;
    const resumeAt = nextResumeAt(at, config);
    const target = resumeAt === null ? at + config.maxSleepChunkMs : Math.min(resumeAt, at + config.maxSleepChunkMs);
    await sleepFn(Math.max(1, target - at), signal);
  }
}

/**
 * Plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig] plugin row config
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger('quiet-hours');

  let dirEnsured = false;
  function audit(entry) {
    if (!dirEnsured) {
      dirEnsured = true;
      try {
        fs.mkdirSync(path.dirname(config.auditFile), { recursive: true });
      } catch (err) {
        logger.warn(`cannot create audit directory: ${err && err.message ? err.message : String(err)}`);
      }
    }
    try {
      fs.promises.appendFile(config.auditFile, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {});
    } catch {
      /* auditing must never break a model call */
    }
  }

  if (!config.enabled) {
    logger.info('disabled by config; model calls are never parked');
    return;
  }
  if (config.windows.length === 0) {
    logger.info('no pause windows configured; model calls are never parked');
    return;
  }

  const describe = () =>
    config.windows
      .map((w) => `${w.days.join(',')} ${formatClock(w.from)}-${formatClock(w.to)}`)
      .join(' | ') + ` (${config.timeZone})`;
  logger.info(`pause windows: ${describe()}`);

  /**
   * `llm/stream` waterfall listener. Returning a generator (not a promise) is
   * required: the caller consumes the value synchronously as an AsyncIterable.
   */
  function handler(options, next) {
    const now = Date.now();
    if (!inPauseWindow(now, config)) return next();
    const resumeAt = nextResumeAt(now, config);
    const where = `${options && options.provider ? options.provider : '?'}/${options && options.model ? options.model : '?'}`;
    logger.info(`parking model call to ${where} until ${new Date(resumeAt ?? now).toISOString()}`);
    audit({ time: now, event: 'pause', resumeAt, provider: options?.provider, model: options?.model, pauseWindows: describe() });

    return (async function* parked() {
      const ended = await waitUntilResume(config, options && options.signal);
      audit({
        time: Date.now(),
        event: ended ? 'resume' : 'cancelled',
        parkedMs: Date.now() - now,
        provider: options?.provider,
        model: options?.model,
      });
      if (ended) logger.info(`pause over after ${Math.round((Date.now() - now) / 1000)}s; starting the model call`);
      else logger.info('parked call was cancelled; releasing it to the adapter');
      yield* next();
    })();
  }

  ctx.effect(() => ctx.on('llm/stream', handler), 'quiet-hours: model-call pause gate');
}
