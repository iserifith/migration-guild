# Quickstart: Validating guildctl Operational Hardening

These are manual/scripted validation scenarios proving each of the nine fixes works end-to-end. Run
from a scaffolded test workspace (see project convention: a dated subfolder under
`migration-guild-test-workspaces`, never the repo root — this repo is the kit's own source, not a
migration workspace). Full automated coverage lives in `migration/test/*.test.ts` (added/extended per
`tasks.md`); this file is the human-runnable proof, not a replacement for those tests.

## Prerequisites

- Built kit: `npm run build:dist` from repo root (or `npm --prefix migration run build` for a faster
  iteration loop against source).
- A fresh test workspace outside this repo, created via the packaged `guildctl-setup`/`setup.js` from
  the just-built `dist/`.
- For US2/US5 (java-spring stack), the workspace's legacy fixture should include `package/mock`
  content classified as `java-spring`, or any workspace with `stacks/java-spring` selected.

## US1 (#153) — Manual arbitration

```bash
guildctl arbitrate --artifact <id> --approve --arbiter operator --reason "manual review ok"
```

**Expected**: exits `0`, prints `✓ Artifact approved: <id>`, no stack trace. Repeat with
`--reject` on a different artifact and confirm the same clean success shape. Then delete/garble any
`run_operator_credentials` row backing a `--run-id` you pass explicitly and confirm the failure path
prints one clean stderr line, exits non-zero, no stack trace.

## US2 (#154) — Stack-correct verify command + blocked-loop stop

```bash
guildctl auto --artifact <java-artifact-id>
```

**Expected**: verify step logs show `javac -proc:none ...`, not `npm test` / `npm error enoent`. Force
a scenario where `javac` is unavailable and confirm the artifact reaches an "unverified" outcome, not
`blocked`. Separately, after a remediation pass would confirm no defect (test harness simulates this
per the added regression test), confirm a subsequent `--resume` does not re-invoke verify and instead
surfaces the artifact for operator attention.

## US3 (#155) — Clean resume from `blocked`

```bash
guildctl auto --artifact <id> --resume
```

**Expected** (artifact currently `blocked`): either a valid resume proceeds, or a clean one-line
message is printed and the process exits non-zero — confirm via `echo $?` that no raw
`RegistryError`/stack trace appears in stderr.

## US4 (#156) — Warden revert never yields false `migrated`

Covered primarily by the added regression test (simulating a warden restore touching an artifact's own
claimed output path mid-migrate). Manual check: after triggering a warden violation restore during a
live `migrate` run, inspect `guildctl status --artifact <id>` and confirm status is not `migrated`.

## US5 (#151) — Bounded verify concurrency

```bash
guildctl auto-run --wave 1 &
guildctl auto-run --wave 1 &
# ... start more than verification.max_concurrent sessions
ps aux | grep javac | grep -v grep | wc -l
```

**Expected**: the live `javac` process count never exceeds the configured (or default) `max_concurrent`
value at any sampled instant, even with more sessions started than that limit.

## US6 (#157) — No stale paths

```bash
grep -rn "migration/dist/" migration/guildctl/commands package/agents package/prompts
```

**Expected**: zero matches. The added regression test enforces this in CI going forward.

## US7 (#158) — Preflight against a reasoning model

```bash
guildctl preflight
```

**Expected** against a known-healthy reasoning-model provider (e.g. a litellm-fronted
`openai/kimi-k3`-class endpoint): reports success, not "provider returned an empty completion." Against
a deliberately wrong endpoint/key, preflight still correctly reports failure.

## US8 (#159) — `init` → `auto` on defaults

```bash
guildctl init
guildctl auto --artifact <id>
```

**Expected**: either this now succeeds, or GETTING-STARTED.md (read prior to this step) already told
the operator the `--db` override was needed before they hit `Error: Autonomous runs require
REGISTRY_DB outside the target workspace`.

## US9 (#150) — Headless setup wizard

```bash
node dist/setup.js < /dev/null; echo "exit=$?"; ls .guild 2>/dev/null && echo "workspace created"
```

**Expected**: exit `0` **and** a `.guild/` directory actually created using default answers — or a
non-zero exit with a clear message. The previously-observed failure mode (exit `0`, nothing created, no
message) must not reproduce.

```bash
printf "1\n2\n<legacy-path>\n" | node dist/setup.js; echo "exit=$?"
```

**Expected**: all three prompts resolve (either from the piped answers or, once input runs out, from
documented defaults with a stderr note), and a workspace is produced.
