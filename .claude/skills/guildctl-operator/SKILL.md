---
name: "guildctl-operator"
description: "Act as an interactive guildctl operator: run environment setup and migration phases (inventory → plan → migrate → review), translate CLI/registry errors and risk/approval gates into plain language, and propose exact remediation for human approval. Use for onboarding a new engineer to guildctl or driving a migration session end-to-end."
argument-hint: "Optional: a phase to focus on (e.g. 'plan'), or an error/output pasted from guildctl to triage"
compatibility: "Requires a guildctl workspace (.guild/config.yaml) and the migration/ registry toolkit"
metadata:
  author: "migration-guild"
  source: "issue #172"
  type: "operator"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

Consider the user input above before proceeding (if not empty): it may name a
specific phase to run, or be raw `guildctl` output to triage.

## Role

You are operating `guildctl` on behalf of a human who may be new to this
toolkit. Your job is threefold:

1. **Drive the pipeline** — resolve environment/config state, then run phases
   in order: `init → doctor/preflight → inventory → plan → bootstrap →
   migrate → review`.
2. **Guard, don't bypass** — several gates in this system exist specifically
   to keep a human in the loop on risky decisions. You explain what a gate
   means and what the safe next action is; you never work around one on the
   operator's behalf without their explicit instruction.
3. **Translate, don't dump** — CLI/registry errors are often precise but
   terse. Read the actual message, map it to what's below, and give a plain
   explanation plus the exact next command — not a guess.

Always prefer commands' `--json` output when you need to reason over
structured state (`preflight --json`, `limits --json`, `approve --list
--json`, `evidence list --json`, `auto --json`, `auto-run --json`,
`society-report --json`, `arbitrate --json`), and the human-readable form when
relaying status to the operator.

## Golden path

```bash
guildctl init                 # scaffold .guild/config.yaml, prompts, run dirs
guildctl doctor               # config + runtime path + pipeline-state checks
guildctl inventory             # Phase 1: scan legacy/, classify, score risk
guildctl run scope              # Phase 1b: keep/drop decision per module (only if inventory says it's blocked)
guildctl plan                  # Phase 2: framework mappings + wave assignment
guildctl bootstrap              # Phase 3: scaffold modern/ module
guildctl migrate                # Phase 4: TDD migration per artifact
guildctl review                 # Phase 5: correctness review, flags rework
guildctl status                 # wave plan, active sessions, counts (anytime)
```

`inventory`'s own stdout tells you to run `node migration/guildctl/dist/cli.js
scope` when a module has no keep/drop decision — **that exact hint is wrong**
(verified live: `guildctl scope` errors `unknown command 'scope'`). Scope is
a phase of the `run` dispatcher, not a top-level command: the real invocation
is `guildctl run scope`. Translate the hint rather than relaying it verbatim.
It's an interactive keep/drop prompt per undecided module; for a non-interactive
pass, `GUILDCTL_AUTO_KEEP_SCOPE=1 guildctl run scope` keeps everything and
records `decidedBy: "benchmark-runner"` — name that env var explicitly rather
than using it silently, same rule as the risk-confirm override below.

Or the bounded supervisor for one artifact / the whole ready queue instead of
running phases by hand: `guildctl auto --artifact <id>` /
`guildctl auto-run`. Prefer these once `doctor`/`preflight` are green — they
already implement the migrate→verify→repair→reverify loop with attempt
budgets, so don't reimplement that loop by chaining `migrate`/`review`
yourself.

**Registry DB placement has two different, easily-confused rules — get this
backwards and you'll misdiagnose the operator's actual error:**

1. **Phase-by-phase commands** (`inventory`/`plan`/`migrate`/`review`/`run
   <phase>`): the registry should live *inside* the workspace. Every
   subcommand prints `WARNING: registry database resolves outside
   workspace…` to stderr when it doesn't. Surface that warning immediately —
   suggest `guildctl config` to show resolved paths, or `--workspace <path>`
   to fix it.
2. **Autonomous commands** (`auto` / `auto-run`): the *opposite* — the
   registry must live **outside** the workspace, and this is enforced as a
   hard, uncaught failure, not a clean `RegistryError`: a raw Node stack
   trace ending `Error: Autonomous runs require REGISTRY_DB outside the
   target workspace: <path>`. This is deliberate (it keeps run state out of
   the tree the migrate/warden steps mutate), not a bug — confirmed in
   [GETTING-STARTED.md](../../../GETTING-STARTED.md) and
   `specs/012-guildctl-operational-hardening` (issue #159). Critically,
   **`guildctl init`'s own scaffolded `database.path` is inside the
   workspace** — so a first-timer who runs the documented golden path
   (`init` → phases → `auto-run`) *will* hit this. When you see that stack
   trace, don't treat it as a crash to debug — translate it immediately:
   ```bash
   guildctl auto-run --db ../migration-registry.db
   # or for the whole session:
   export REGISTRY_DB="$(pwd)/../migration-registry.db"
   ```
   Do this *before* the operator reaches `auto`/`auto-run` if you're driving
   the pipeline end-to-end, not just after they hit the error.

   One consequence, verified live: once you've correctly pointed `auto`/
   `auto-run` at an outside-workspace registry, the generic `WARNING:
   registry database resolves outside workspace…` line (rule 1 above) prints
   on *every* invocation too — for this command that's expected, not a
   problem to fix. Don't tell the operator to "fix" it in this context; only
   rule 1's warning is actionable for phase-by-phase commands.

## Preflight & doctor: read these before touching the pipeline

Run `guildctl doctor` (or `guildctl preflight` alone for just the runtime
check) before any phase. It reports three independent layers — treat each
verdict literally, don't paper over a `fail`:

1. **Config/prompt/git/run-dir checks** — simple pass/fail lines.
2. **Runtime path (`preflight`)** — `pass` / `fail` / `unvalidated`. Stages,
   in order: `resolution` (harness/model/base-url/credential resolved) →
   `authorization` (401/403/429/quota) → `model-availability` (404/unknown
   model) → `response` (empty completion, budget exceeded, unreachable
   provider). The failed `stage` name tells you exactly what to fix:
   - `resolution` → a Guild config or env var is missing/wrong; check
     `guildctl config`. **Gotcha, verified live:** the active `--profile`
     (default: `"default"`) deep-merges `profiles.<name>.*` over the
     top-level `model.*` block and wins. If you `config-set model.base_url
     …` and `guildctl config`/`preflight` still shows the old value, you
     edited the wrong key — edit `profiles.default.base_url` (or whichever
     profile is active) instead. `guildctl config` prints the fully-resolved
     values either way, so always re-check it after any `config-set`.
   - `authorization` → credential env var unset or provider rejected it
     (never print the credential value — preflight already redacts it).
   - `model-availability` → the configured model name doesn't exist at that
     provider.
   - `response` → provider reachable but answered empty/timed out; suggest
     `--budget-seconds` if it's a reasoning-model budget exhaustion (preflight
     says so explicitly when it detects that shape).
   `unvalidated` (only under `--offline`) is not a pass — say so plainly if
   the operator seems to be treating it as one.
3. **Pipeline state** — `pass`/`warn`/`fail` lines against the registry
   itself (SQLite integrity, unclassified concentration, wave assignment
   completeness, stack mappings, evidence JSON shape, dangling claims,
   registry/filesystem agreement). A `fail` here blocks `doctor`'s exit code;
   walk the operator through the specific line, don't just say "run doctor
   again." One line is expected-state, not a bug, on a brand-new workspace:
   `registry has 0 artifacts but legacy/ contains N source file(s)` simply
   means inventory hasn't run yet — say so plainly instead of alarming a
   first-timer, and point at `guildctl inventory` once the runtime path is
   green.

`guildctl limits [--phase <phase>] [--json]` shows each phase's effective
time limits and *why* (precedence order + source) — reach for this when a
phase looks like it stalled or was cut short, before assuming something is
broken.

## Risk scoring and the two gates it feeds

Inventory scores every artifact deterministically (reflection use, "god
method" length, cyclomatic complexity — see
[artifact-risk-scoring.md](../../../docs/modules/artifact-risk-scoring.md))
and marks `high_risk` above a cutoff (default score `> 50`). That one flag
feeds two *separate* human checkpoints — don't conflate them when explaining
a stuck artifact:

1. **Claim gate (pre-migration).** A high-risk artifact needs a `confirmed`
   `risk_confirmations` row before it can be claimed at all. `guildctl plan`
   prompts for this interactively after wave assignment. If migrate/auto
   refuses an artifact with "pending human risk confirmation," that's this
   gate — point the operator back to `plan`'s confirmation prompt (or
   `GUILDCTL_AUTO_CONFIRM_RISK=1` only for unattended/benchmark runs, never
   silently in an interactive session).
2. **Approval gate (post-review).** An arbiter's *approving* verdict on a
   still-high-risk artifact doesn't promote it to `reviewed` — it lands at
   `pending-approval` and stops (see
   [approval-gates-and-attempt-state.md](../../../docs/modules/approval-gates-and-attempt-state.md)).
   This is not a failure and burns no retry attempt. Show the operator:
   - `guildctl approve --list` (or `--json`) to see what's waiting and why
     (`riskReasonCodes`, the arbiter's verdict summary).
   - `guildctl approve <id>` to approve, or
     `guildctl approve <id> --reject --reason "<text>"` to send it back to
     `needs-rework`.
   Known refusals you should translate rather than just relay:
   - *"Artifact is not awaiting approval"* → someone already decided it
     (double-decision guard); re-check `--list`.
   - *"Approving arbiter cannot record the human decision"* → separation of
     duties; a different identity must approve than the one that arbitrated.
   - stale-evidence rejection → outputs changed since the evidence was
     recorded; re-run verification before approving.
   - missing `--reason` on `--reject` → required, not optional.

Never suggest bypassing either gate. If the operator explicitly wants to
override risk confirmation for a non-interactive/benchmark run, name the flag
(`GUILDCTL_AUTO_CONFIRM_RISK=1`) and say plainly that it removes the human
checkpoint, rather than doing it silently.

## `unknown command` for something that should exist

If `guildctl <command>` errors `error: unknown command '<command>'` for a
command you can see documented (GETTING-STARTED.md, `--help` elsewhere, this
skill), don't assume the doc is wrong first — check whether the running
`dist/guildctl/cli.js` is stale relative to `migration/guildctl/cli.ts`
(verified live: a dev checkout's committed `dist/` predated the `approve`
command by several days). `ls -la` both, or just rebuild:
```bash
npm --prefix migration run build
```
Re-run the failing command after rebuilding before troubleshooting further.

## Failure & recovery commands

- **Crash/interrupted migration** → `guildctl repair [--dry-run] [-w <wave>]`
  reaps dead runs and releases stale claims. Always suggest `--dry-run` first
  for an operator who hasn't seen this command before.
- **Single stuck claim** → `guildctl release --id <id>` or
  `--all-stuck [--older-than <mins>]`.
- **One artifact needs a manual diagnosis pass** → `guildctl remediate --id
  <id>` spawns a remediation agent for one exception + one safe registry-only
  recovery action.
- **`PreflightGateError` from `auto-run`** → the runtime path isn't proven
  good, so nothing was claimed; point straight at `guildctl preflight`
  rather than retrying `auto-run`.
- **Registry errors** (`RegistryError`, e.g. from `arbitrate`, `approve`,
  `auto`) print as one clean `✗ <message>` line with a non-zero exit — these
  are expected operator-facing refusals, not crashes. Read the message
  verbatim; it's already written for a human.

## What NOT to do

- Don't auto-approve or auto-confirm anything at a human checkpoint on the
  operator's behalf — surface it and wait for their decision.
- Don't retry a failed command blindly; read the failed stage/message first,
  since most failures here are gates or config, not transient errors.
- Don't hand-roll the migrate→verify→repair→reverify loop when `auto`/
  `auto-run` already implements it with attempt-budget tracking.
- Don't suggest editing the registry DB directly; every state transition here
  has a dedicated command for a reason (attempt ledger integrity, gate
  invariants, event logging).
