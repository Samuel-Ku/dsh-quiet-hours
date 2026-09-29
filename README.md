# dsh-quiet-hours

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that parks every model call until a configured pause window is over, so a long task stops itself during expensive hours and continues on its own when off-peak starts.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node: >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Nothing is restarted and nothing is spent while parked: the turn stays open, the request has not been sent, and the task resumes from exactly the same place when the window ends.

## How it hooks in

The gate sits on the `llm/stream` waterfall — the hook `@deepseek-ai/dsh-llm` describes as the "waterfall around every streaming model call (retry, replay, routing)". During a pause window the listener returns an async generator that does not start the underlying request until the window is over.

One contract detail is easy to get wrong, and this plugin is built around it: the listener must return an `AsyncIterable<StreamChunk>` **synchronously**, because the caller consumes the waterfall result without awaiting it. A promise there would break every model call. That is why the wait lives inside the generator body rather than in the listener, and `test/probe.test.mjs` asserts it directly.

```js
function handler(options, next) {
  if (!inPauseWindow(Date.now(), config)) return next();
  return (async function* parked() {
    await waitUntilResume(config, options.signal);
    yield* next();
  })();
}
```

**Tools are not gated.** They cost no tokens, and the model call that would consume their output is parked anyway — gating them would only risk interrupting a half-finished side effect.

## Windows

A window is a wall-clock interval in an IANA timezone, evaluated through `Intl`, so DST is the platform's problem rather than offset arithmetic's:

```yaml
windows:
  - days: [mon, tue, wed, thu, fri]   # the day the window STARTS on
    from: "01:00"
    to: "04:00"
```

- `from < to` — a same-day window; the start is inclusive, the end exclusive.
- `from > to` — spans midnight and belongs to the day it starts on, so a Friday `22:00–06:00` window covers Saturday 00:00–06:00 and nothing on Sunday.
- `from == to` — rejected at load; a zero-length window is always a mistake.

An unknown timezone, a malformed `HH:MM`, or an unknown weekday name **fails the plugin mount** with a message naming the offending entry, rather than silently never pausing.

## Configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | `boolean` | `true` | `false` = never park |
| `timezone` | `string` | `UTC` | IANA zone the windows are written in |
| `windows` | `list` | `[]` | pause windows; empty means never park |
| `maxSleepChunkMs` | `number` | `60000` | wake-up cadence while parked (keeps the plugin responsive to clock jumps and aborts) |
| `scanCapMs` | `number` | `21 days` | how far the resume search looks before giving up and re-checking |
| `auditFile` | `string` | `~/.dsh/logs/quiet-hours.jsonl` | JSONL trail of park/resume events |

Peak-pricing example — work parks during peak and resumes the instant off-peak starts:

```yaml
- id: quiet-hours
  name: dsh-quiet-hours
  config:
    enabled: true
    timezone: UTC
    windows:
      - days: [mon, tue, wed, thu, fri]
        from: "01:00"
        to: "04:00"
      - days: [mon, tue, wed, thu, fri]
        from: "06:00"
        to: "10:00"
    auditFile: /home/me/.dsh/logs/quiet-hours.jsonl
```

## Install

```bash
dsh plugin --profile web add /path/to/dsh-quiet-hours
```

The bundle's `cordis.patch.yml` inserts the `quiet-hours` entry; override its `config` by id in the profile's `cordis.patch.yml` (do **not** re-insert it — that fails with `duplicate loader entry id`).

For a path or `link:` install, keep the checkout under `$DSH_HOME/profiles/` so Node resolves the `@deepseek-ai/*` peers from `$DSH_HOME/profiles/node_modules`.

A **new** plugin module only mounts on a DSH restart; afterwards config edits reload live under `patchReload: live`.

## Audit trail

One JSONL line per park and per resume, at `auditFile`:

```json
{"time":1790422374944,"event":"pause","resumeAt":1790433600000,"provider":"openrouter-jev","model":"typesafe/jev-router","pauseWindows":"mon,tue,wed,thu,fri 01:00-04:00 | mon,tue,wed,thu,fri 06:00-10:00 (UTC)"}
{"time":1790433600012,"event":"resume","parkedMs":11225068,"provider":"openrouter-jev","model":"typesafe/jev-router"}
```

`event` is `pause`, then `resume` (with `parkedMs`) or `cancelled` when the turn was aborted while parked.

## Tests

```bash
npm install
npm test
```

25 tests in two layers:

- `test/logic.test.mjs` — clock parsing, config validation, window containment across timezones, weekends, same-day and overnight windows, the resume search, and the wait loop driven by an injected clock so hours pass instantly.
- `test/probe.test.mjs` — mounts the plugin on a **real Cordis context** and drives the `llm/stream` waterfall the way `LlmRuntime.stream()` does. It asserts pass-through outside a window, parking inside one, the "AsyncIterable, not a promise" contract, release on abort, gate removal on unload, and a loud mount failure on a bad timezone.

The `devDependencies` exist only so the tests run from a bare clone; at runtime the plugin resolves its `@deepseek-ai` peers from the DSH install.

## Caveats

- A parked call is a live promise, not durable state: restarting DSH, or ending the session, discards it. The task does not resume by itself after a restart.
- Approvals and auto-answered questions go through the same waterfall, so a judge call raised during a pause is parked too. In practice that is consistent — a parked agent raises no new requests — but it is worth knowing.
- The longest park is bounded only by your windows; the wake-up cadence means the plugin re-checks the clock once a minute, so a wall-clock change is noticed promptly.

## License

MIT — see [LICENSE](LICENSE).
