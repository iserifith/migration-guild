# Quickstart: Validating the Always-On Supervisor Staleness Sweep

## Prerequisites

- A working `migration-guild` checkout with `migration/` dependencies installed (`npm --prefix migration install`).
- The feature implemented per `plan.md`/`tasks.md` (periodic sweep wired into `runAutoQueue` in `migration/guildctl/supervisor/queue.ts`).

## 1. Automated validation (primary path)

Run the extended `migration/test/auto-queue.test.ts` suite, which exercises `runAutoQueue` directly with an injected clock and fake `executeArtifact`/registry fixtures — no real 10-minute wait required:

```bash
cd migration
node --import tsx --test test/auto-queue.test.ts
```

Expected: new test cases covering —
1. A sweep does not fire before the configured interval elapses (no extra `reapDeadRuns`/`reconcileStaleClaims` calls beyond the startup one).
2. A sweep fires once the injected clock crosses the interval boundary between loop iterations, and its recoveries land in `AutoQueueResult.recoveredArtifacts`.
3. A sweep that finds nothing produces no extra output.
4. A sweep that throws is caught, logged as non-fatal, and the loop continues processing remaining artifacts (queue still reaches a terminal status other than a spurious `failed`).
5. `GUILDCTL_SWEEP_INTERVAL_MINS` set to an invalid value (`"0"`, `"-5"`, `"abc"`) falls back to the 10-minute default.

Run the full `migration` suite before considering the feature done, per the constitution's Development Workflow gate:

```bash
npm --prefix migration test
```

## 2. Manual/operational validation (optional, for a human sanity check)

This simulates the real-world scenario without waiting a full default interval, by overriding the interval to something short via the environment variable.

```bash
# From a scratch workspace with a guildctl-initialized registry and a wave of
# several artifacts queued (see package/mock/ fixtures for a ready-made sample).
GUILDCTL_SWEEP_INTERVAL_MINS=1 node migration/guildctl/dist/cli.js auto-run --wave 1 --limit 5
```

Expected observations:
- The existing startup-sweep behavior is unchanged (any pre-existing stale claims are reaped/reconciled before the first artifact is claimed, as today).
- If a claim held by an unrelated process (or one you artificially age past the threshold by editing `artifact_claims.heartbeat_at` in the registry DB while the session runs) goes stale mid-session, within roughly one interval (~1 minute with the override above) a console line appears identifying it as a periodic-sweep recovery, distinct from the startup-sweep line.
- No such line appears if nothing goes stale during the run.
- The session's final JSON output (`--json`) includes the recovered artifact ID(s) in `recoveredArtifacts`.

## 3. Non-goals to confirm are unaffected

- `guildctl auto <artifact>` run standalone for a long time does **not** gain periodic sweeping (confirm no new console output appears from this feature during a long single-artifact `auto` run).
- `guildctl doctor` and `guildctl repair` behavior is byte-for-byte unchanged.
