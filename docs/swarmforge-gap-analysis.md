# SwarmForge Gap Analysis

## Overview

[SwarmForge](https://github.com/unclebob/swarm-forge) (Bob Martin) and Migration Guild are solving adjacent problems from opposite ends: SwarmForge is **local-first** — a pack of agent CLIs running in tmux panes, with a human (`Cockpit`) watching and steering them live. Migration Guild is **repo-first** — a registry-gated pipeline driven by `guildctl`, with agents claiming work from a SQLite blackboard and a human approving high-risk output after the fact (Spec-013).

This document scopes the comparison to the Migration Guild product itself — the pipeline `guildctl` runs (registry, `package/agents/`, dashboard) — and each proposal below targets that pipeline. It is an analysis document, not an implementation: what SwarmForge does, where Migration Guild actually stands today (with file references), and a concrete, scoped proposal for whoever picks it up.

---

## 1. Role constitutions as versioned prompt articles

SwarmForge keeps every agent's behavioral contract in `constitution/articles/*.prompt` — reviewed, diffed, and tested like code, injected by the launcher at spawn time.

**Where Migration Guild actually stands:** closer to this than the original framing suggested. `package/agents/*.agent.md` (`migration-agent.agent.md`, `review-agent.agent.md`, `remediation-agent.agent.md`, etc.) are already versioned, Markdown-frontmatter prompt files, checked into the repo and diffed in PRs like any other source file — e.g. `package/agents/migration-agent.agent.md` is a 49-line numbered-steps contract ("claim one task, tests before production code, never write to `legacy/`"). So the *artifact format* SwarmForge is praised for already exists here.

What's genuinely missing, compared to SwarmForge's constitution:
- **No test coverage on the prompts themselves.** SwarmForge's issues.md discipline (#5 below) is explicitly regression-tested; nothing in this repo asserts that `migration-agent.agent.md` still says "tests before production code" after an edit. A cheap `doc-consistency`-style test (the pattern already used for stale-path regressions per issue #148/PR #149) could grep each `.agent.md` for its load-bearing rules.
- **No shared "articles" layer.** Each `.agent.md` restates its own guardrails (don't write to `legacy/`, no stubs, no TODOs) inline rather than importing a common constitutional base. SwarmForge's `articles/*.prompt` are composed per role; Migration Guild's agents duplicate the same handful of invariants across files. A `package/agents/_articles/` (or similar) directory with 2-3 shared fragments (workspace boundaries, no-stub discipline, evidence-before-claim) that each `.agent.md` references would cut duplication and make a guardrail change a one-file edit instead of an N-file grep-and-replace.

**Proposal:** (a) add a doc-consistency test asserting each `package/agents/*.agent.md` retains its numbered guardrail steps; (b) factor the 3-4 repeated invariants into a shared fragment referenced by each agent file.

---

## 2. Structured handoff envelopes

SwarmForge's handoffs are Maildir messages with `From`/`To`/`Task`/`Payload` headers, queued by `handoffd`, with rejection reasons routed back to the owning agent automatically.

**Where Migration Guild actually stands:** Spec-013 (`specs/013-approval-gate-attempt-state/`) shipped the *gate* half of this — `POST /api/approvals/:id/decision` (US2 in `spec.md`), backed by `recordApprovalDecision`/`listPendingApprovals` in `migration/registry/commands/evidence.ts`, plus an attempt-history schema (US3) that durably records each retry's failure reason and attempt number, surviving process restarts. What it does *not* have is a **message protocol**: agents don't address each other. Coordination is entirely implicit — an agent claims a row in the registry, mutates its status, and the next phase discovers that mutation by re-querying the DB. There's no `From`/`To`/`Task` envelope, and — this is the concrete gap — a reject reason recorded via the approval-gate decision endpoint does not automatically flow into the *next migrate attempt's prompt*. US3's acceptance criteria (`spec.md` Acceptance Scenario 2) only requires the reason be *queryable after the fact*, not injected back into remediation.

**Proposal:** this doesn't need SwarmForge's Maildir transport — the registry is already the shared bus. It needs a thin envelope *convention* layered on what exists:
- When `recordApprovalDecision` records a rejection, write the reason into the same `agent_context` table `migration/registry/commands/context.ts` already writes to (`migration/artifacts/<slug>/context/<agent>.md`), tagged for the next remediation attempt, instead of leaving it queryable-only.
- Give `remediation-agent.agent.md` an explicit step: "before attempting, read the most recent rejection reason from context, if any" — turning US3's stored history into an actual input to the next attempt, closing exactly the loop SwarmForge's reject-routing gives for free.

This is a small, additive change on top of Spec-013, not a new subsystem.

---

## 3. Adversarial lanes

SwarmForge runs a dedicated `adversaries` branch/pack whose sole job is attacking the other pack's implementation before merge.

**Where Migration Guild actually stands:** two friendly layers — `review-agent` (independent critic) and the arbiter gate — plus, per Spec-013, a human approval gate for above-risk-cutoff artifacts. None of these are adversarial by design; they're all reviewing for correctness against the spec, not actively trying to break the artifact against the stack's test gates. `review-agent.agent.md`'s job (worth reading before proposing this) is diagnosis, not attack.

**Proposal:** insert one additional agent role — `adversary-agent.agent.md` — that runs after `review` passes and before the approval gate opens (i.e., between the existing `review` phase and the point where `evidence.ts` would otherwise let a below-cutoff artifact complete unattended). Its prompt is deliberately narrow: given the artifact and the stack's configured verify command, try to construct an input or test case that passes the existing test suite but violates the spec's intent (off-by-one on the migrated boundary, a config value that silently defaults instead of erroring, an auth check that short-circuits). A failure here should route the artifact back to rework the same way a human rejection does (reusing the plumbing from §2), not open a second parallel gate. This is the one item here that's genuinely new work rather than an extension of something shipped — scope it as its own spec before building.

---

## 4. Stuck-runner watchdog

SwarmForge's `swarm-window-watchdog` watches tmux windows and reaps dead sessions; cleanup sweeps everything on exit.

**Where Migration Guild actually stands — correcting the original "absent" framing:** the registry already has this, non-trivially:
- `reapDeadRuns` (`migration/registry/commands/runs.ts`, wired into `migration/guildctl/supervisor/queue.ts:245`) and `reconcileStaleClaims` (`migration/registry/commands/claim.ts`, `queue.ts:246`) run automatically inside `guildctl auto`'s supervisor loop.
- `guildctl doctor` (`migration/guildctl/doctor.ts:229-247`) actively flags "dangling active claims older than 1h" by checking `heartbeat_at`/`claimed_at` against the `artifact_claims` table.
- `guildctl recover` (`cli.ts:442`) and `guildctl release --all-stuck --older-than <mins>` (`cli.ts:410-413`) exist as explicit, human-triggerable reapers.

So the registry-claim layer already has heartbeats, TTLs, and a reaper — SwarmForge's idea, already shipped, just under different names.

**What's still a gap:** all of the above requires a human to *run* `guildctl doctor` or `guildctl recover` to surface a stuck claim — there's no automatic, always-on sweep the way SwarmForge's watchdog runs continuously in the background. `printStaleSessionWarnings` (`migration/guildctl/monitoring.ts:379`) prints staleness info but isn't wired into a standing reaper loop outside of `auto`'s supervisor.

**Proposal:** add a periodic check inside the supervisor loop (`migration/guildctl/supervisor/queue.ts`) that calls the same `doctor` staleness check on a fixed interval during long-running `auto`/`auto-run` sessions, not just at startup — so a claim that goes stale mid-run gets flagged without a human having to think to run `doctor`.

---

## 5. Whole-card discipline

SwarmForge's `issues.md` #3 fixes card-slicing by putting it directly in the specifier's prompt: "finish the entire assigned card, then exactly one handoff" — and it's regression-tested.

**Where Migration Guild actually stands:** by convention only, and only implicitly, inside the pipeline's own task granularity. `package/agents/migration-agent.agent.md`'s numbered steps (claim → read → migrate dependencies → write test → write production → mark migrated → claim next) imply single-artifact completion, but nothing states it as an explicit rule the way SwarmForge does, and there's no regression test enforcing it.

**Proposal:** this is the cheapest item on this list — a one-line, testable addition:
- Add an explicit rule to the top of `package/agents/migration-agent.agent.md` (and `test-writer-agent.agent.md`, `codegen-agent.agent.md`): "Do not hand off partial work. Complete every step for the claimed artifact — test written, production code written, registry updated to `migrated` — before claiming the next one."
- Pair it with the doc-consistency test proposed in §1, so the rule can't silently drop out of the prompt on a future edit — this is exactly the kind of thing SwarmForge treats as a regression test, not just prose.

---

## 6. Status inference for the operator dashboard

SwarmForge's Cockpit scrapes raw tmux `capture-pane` output, strips backend-specific chrome (Grok/Codex alt-screen sequences), and infers idle / working / waiting-for-approval / rejected states plus an activity-heat signal — all without instrumenting the agents themselves.

**Where Migration Guild actually stands:** materially further along than "vocabulary missing." Spec-013 US4 (`specs/013-approval-gate-attempt-state/tasks.md:132-141`) shipped a pending-approvals panel: a read endpoint (T026, `listPendingApprovals`), a decide endpoint (T027, `recordApprovalDecision`), a UI panel with an explicit non-error empty state (T028/T029), tested (T024/T025/T030). So two of SwarmForge's four inferred states — **waiting-for-approval** and **rejected** — already exist as *first-class, instrumented* states in Migration Guild, not inferred from scrollback. That's actually a stronger foundation than SwarmForge's: Migration Guild doesn't need to scrape output to know an artifact is waiting, because the registry already knows.

What SwarmForge's taxonomy still contributes: **idle** and **working** aren't states Migration Guild's registry currently distinguishes at the run level for live display — `printStaleSessionWarnings` (`migration/guildctl/monitoring.ts:379`) exists for staleness, but there's no dashboard-facing "this claim is actively being worked right now vs. sitting idle between heartbeats" signal analogous to SwarmForge's activity heat.

**Proposal:** don't adopt SwarmForge's scrape-and-strip mechanism (Migration Guild has structured state, not a terminal to parse) — adopt its four-state *vocabulary* as the UI's status enum, mapped onto data the registry already has:
- `waiting-for-approval` / `rejected` → already shipped (US4).
- `working` → derive from `heartbeat_at` recency on `artifact_claims` (the same column `doctor` already reads for staleness — §4).
- `idle` → the default state, no active claim.
This is a UI/API-layer task, not a new instrumentation project: the data backing three of the four states already exists in the schema; it's a matter of exposing it as a named status alongside the pending-approvals panel rather than inventing new tracking.

---

## ⚠️ Anti-steal: what SwarmForge got wrong

The original comparison flagged two specific lessons — validate every name that touches a path, and never let one bad request kill the dashboard — as bugs to *not* repeat. Checking Migration Guild against both surfaced a real, unfixed instance of the first:

**Path validation gap — confirmed, not hypothetical.** `validateId` (`migration/registry/types.ts:559-567`) only checks that an artifact ID splits into three non-empty colon-separated parts (`<kind>:<module>:<ClassName>`); it does not reject path-traversal characters. `idToSlug` (`types.ts:555-557`) only lowercases and replaces `:` with `--` — it does not strip `/` or `..`. `writeContext` (`migration/registry/commands/context.ts:21-43`) then builds a filesystem path directly from that slug:

```typescript
// migration/registry/commands/context.ts:38-42
const slug = idToSlug(id);
const destDir = path.join("migration", "artifacts", slug, "context");
fs.mkdirSync(destDir, { recursive: true });
const destFile = path.join(destDir, `${agent}.md`);
fs.copyFileSync(filePath, destFile);
```

An ID like `kind:../../../tmp/pwned:Class` passes `validateId` (three non-empty parts) and survives `idToSlug` unchanged apart from casing, so `path.join` normalizes the `..` segments and `writeContext` can be made to write outside `migration/artifacts/` entirely — exactly the class of bug the anti-steal note is warning about, already present, not just a risk. `writeContext`'s only callers today go through `validateId`, so this needs an explicit allowlist check (e.g. reject any ID segment containing `/`, `\`, or `..`) rather than relying on the three-non-empty-parts shape check to double as sanitization.

**Dashboard resilience — spot-checked, looks solid, worth a second pass.** `serve.ts`'s decision and artifact-detail handlers wrap their bodies in `try`/`catch` (lines 74-76, 156-181) rather than letting a bad request bubble into an unhandled rejection that could take the process down — the pattern SwarmForge's Cockpit reportedly lacked. This wasn't audited exhaustively (every route, every input shape) — worth confirming as part of whatever picks up §3's adversary-agent idea, since "throw malformed input at the dashboard" is exactly its remit.

**Recommendation:** file the path-traversal issue in `validateId`/`writeContext` as its own bug (it's a real, exploitable-by-a-malicious-or-buggy-agent gap, independent of anything else in this doc) rather than letting it ride along as a footnote here.
