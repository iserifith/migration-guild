<!--
Sync Impact Report
==================
Version change: (template, unversioned) → 1.0.0
Bump rationale: MINOR-to-initial. First concrete ratification of the constitution; all
placeholder tokens replaced with project-derived governance. Treated as 1.0.0 rather than a
PATCH because every principle is newly defined rather than clarified.

Modified principles (template slot → concrete principle):
  - [PRINCIPLE_1_NAME] → I. Evidence Over Assertion
  - [PRINCIPLE_2_NAME] → II. Legacy Is Read-Only; `modern/` Is the Only Write Target
  - [PRINCIPLE_3_NAME] → III. Registry-Mediated Coordination
  - [PRINCIPLE_4_NAME] → IV. Separation of Powers: Builder, Critic, Arbiter
  - [PRINCIPLE_5_NAME] → V. Tests Before Production Code
  - (added) → VI. Fail-Closed Automation
  - (added) → VII. Pluggable Stacks, Neutral Providers

Added sections:
  - [SECTION_2_NAME] → Repository Source-of-Truth Boundaries
  - [SECTION_3_NAME] → Development Workflow and Quality Gates
  - Principles VI and VII (beyond the five template slots)

Removed sections: none.

Follow-up TODOs:
  - TODO(RATIFICATION_DATE): original adoption date not recorded in repo history. The first
    commit is 2026-03-30 ("feat: initial legmod kit"), but that is project inception, not
    constitution adoption. A maintainer must supply the governance ratification date.
-->

# Migration Guild Constitution

## Core Principles

### I. Evidence Over Assertion (NON-NEGOTIABLE)

Intent is cheap; evidence is required. No artifact advances on an agent's self-report.

- Every status transition MUST be backed by a record in the registry. An agent claiming
  "done" without a corresponding evidence row MUST be rejected.
- Arbitration approval MUST require the latest verifier-generated runtime evidence to exist,
  to pass, to carry authenticity data (`authenticity` + `log_sha256`), and to be fresh with
  respect to any subsequent repair cycle.
- Evidence MUST be content-bound. When a migrated output changes, prior evidence for that
  output becomes stale and MUST NOT satisfy a gate.
- Exit code zero is not completion evidence. Phases MUST verify their own postconditions
  (for example, inventory requires `mark-inventory-complete` plus a passing quality gate).
- High-risk signature drift between legacy and migrated code MUST block approval rather than
  produce a warning.

Rationale: the failure mode this project exists to prevent is a model reporting progress it did
not make. Gates that trust the actor are not gates.

### II. Legacy Is Read-Only; `modern/` Is the Only Write Target (NON-NEGOTIABLE)

The user's source of truth MUST survive the migration untouched.

- `legacy/` is read-only. No agent, phase, or remediation step may create, modify, or delete
  files there.
- `modern/` is the only write target for migrated code, and writes MUST stay within the paths
  a claim authorizes.
- The warden MUST snapshot and verify the workspace around agent execution, and out-of-scope
  creates, modifies, and deletes MUST be reported as violations.
- Remediation is registry-only. Stalled, blocked, failed, or `needs-rework` items MUST be
  triaged by requeueing registry state, never by hand-editing source during triage.
- If `legacy/` was modified by any prior run, work MUST stop until it is restored from version
  control or a fresh copy.

Rationale: an irreversible edit to a user's legacy codebase is the one error this system cannot
apologize its way out of.

### III. Registry-Mediated Coordination

Agents coordinate through the shared SQLite registry (WAL mode), not through conversation.

- All migration state — artifacts, classifications, waves, dependencies, claims, runs, events,
  evidence — MUST live in the registry. Chat transcripts are not state.
- Work MUST be acquired through atomic claims carrying a `claim_id` and `claim_token`, with
  lease timestamps and heartbeats. A worker MUST claim exactly one artifact per run.
- Status transitions MUST present an active claim token or a valid run operator credential.
  Privileged-looking actor names (`operator`, `guildctl`, `remediation-agent`) MUST NOT bypass
  an active claim.
- Claims MUST be recoverable without human intervention: lease expiry, run-ID cleanup, owner-ID
  cleanup, and stale-run reconciliation all release work back to the pool.
- Each workspace MUST resolve its own registry. Registry path precedence is explicit flag >
  `REGISTRY_DB` env > config > workspace default, and a registry inside the toolkit checkout
  MUST warn.

Rationale: a crashed agent must never deadlock the pipeline, and two agents must never silently
migrate the same file.

### IV. Separation of Powers: Builder, Critic, Arbiter

The party that produces work MUST NOT be the party that certifies it.

- The arbiter MUST be independent from the evidence producer. Approval where
  `evidence.produced_by` equals the arbiter MUST be refused.
- Review is an independent critic pass, not a self-check appended to codegen.
- A `migrated` artifact is not a finished artifact. Only `reviewed`, `completed`, or `skipped`
  MUST unlock dependent downstream work.
- The arbiter gate decides the terminal outcome: approve, or route to `needs-rework`.

Rationale: self-certification collapses the whole evidence chain back into self-report, which
Principle I exists to forbid.

### V. Tests Before Production Code

Observable behavior MUST be pinned by target-side tests before the production code is written.

- The migrate phase MUST write tests first, then production code (`tests-written` precedes
  `migrated`).
- Tests MUST use the target test framework. Legacy and target test annotations MUST NOT be
  mixed.
- Migrated code MUST NOT carry source-framework imports, annotations, or references to legacy
  XML configuration.
- Configuration MUST use the target framework's property injection. Hardcoded URLs, ports,
  credentials, and stray string literals MUST NOT be introduced.
- Kit behavior itself MUST be covered by the `migration/test` suite. Changes to claims,
  evidence gates, arbitration, warden scope, or phase control flow MUST ship with regression
  tests.

Rationale: a migration without target-side tests has replaced code whose behavior was known
with code whose behavior is assumed.

### VI. Fail-Closed Automation

Autonomous execution MUST stop rather than guess.

- `auto-run` MUST be fail-closed: it continues independent work after one artifact blocks, but
  MUST halt on systemic executor errors instead of dispatching another artifact.
- Credential and provider preflight MUST fail closed, and secret values MUST be redacted in all
  output.
- Timed-out agent processes MUST be terminated (SIGTERM then SIGKILL) or explicitly marked for
  review, never left running as silent zombies.
- Output MUST be silence-first: one final summary per run, with detail available through the
  registry and run logs rather than streamed noise.
- Bounded canaries (`--wave`, `--limit`) MUST remain available so operators can test a slice
  before committing a full run.

Rationale: an autonomous pipeline that guesses past an unexplained failure converts one bad
artifact into a corrupted run.

### VII. Pluggable Stacks, Neutral Providers

Stack-specific and vendor-specific knowledge MUST stay behind stable interfaces.

- Per-stack rules — classification heuristics, framework mappings, audit rules, scaffold
  templates — MUST live in stack packs (`stacks/`, `package/stacks/`), not in core runtime code.
- Stack packs MUST supply a structured `classification.yaml` referenced from `stack.yaml`,
  declaring allowed frameworks, aliases, an explicit fallback, ambiguity handling, the registry
  role vocabulary, source-root module rules, deterministic signals, and quality thresholds.
- Classification MUST use the registry's role vocabulary. Stack-specific roles MUST NOT be
  invented, and fallback classification MUST prove high-confidence negative evidence rather
  than absorb unmatched files.
- The LLM layer MUST remain OpenAI-compatible and configuration-driven. No provider-specific
  behavior may be hardcoded into the pipeline.
- Agent harnesses MUST stay swappable through the harness adapter layer, with `AGENT_CMD` as
  the escape hatch for custom binaries.

Rationale: the coordination substrate is the durable asset. Stacks, models, and harnesses will
all be replaced faster than the registry and gates will.

## Repository Source-of-Truth Boundaries

This repository is the source code for the Migration Guild kit. It is NOT a migration workspace.

- `migration/` is the canonical source for registry and guildctl runtime code.
- `package/` is the source of truth for shipped Agent artifacts: `agents/`, `skills/`,
  `prompts/`, `instructions/`, `agent-instructions.md`. If a capability must exist in user
  workspaces, it MUST be represented in `package/`.
- Root `.github/` is maintainer-only repo context and MUST NOT ship. Shipped agents, prompts,
  skills, or path instructions MUST NOT be mirrored back into it.
- Runtime code MUST NOT be mirrored between `migration/` and `package/`.
- Migration phases MUST NOT be run against this repository root, and repo-root `legacy/` or
  `modern/` trees MUST NOT be recreated. Validating installed behavior requires a fresh
  workspace outside this repository, using `package/mock/` for sample content.
- The distributable is assembled by `scripts/build-dist.mjs` from `package/`, selected
  top-level docs, and the compiled installer.

## Development Workflow and Quality Gates

- Tool dependencies MUST be fully pinned with explicit `overrides` in both the development and
  packaged runtime manifests.
- `npm test` MUST pass before a change is considered complete. It runs the `migration` suite
  and the Mission Control UI suite.
- Every change MUST answer the maintainer checklist: is it repo-only or shipped; did `package/`
  need updating; did `migration/` need updating; did `DEVELOPMENT.md` need updating; does it
  belong in `CHANGELOGS.MD`.
- Changes to maintainer workflow, packaging, or source-of-truth boundaries MUST be captured in
  `DEVELOPMENT.md`.
- Notable changes MUST be added to `CHANGELOGS.MD` under `Unreleased`, grouped by a
  human-readable date heading. These headings group development batches; they are not release
  dates.
- Docs MUST be maintained by audience: `README.md` and `GETTING-STARTED.md` for kit users,
  `DEVELOPMENT.md` and `CHANGELOGS.MD` for maintainers.
- Changes to claim, lease, evidence, or run-lifecycle semantics MUST update both maintainer
  docs and any external runtime architecture notes.

## Governance

This constitution supersedes other practices and conventions in this repository. Where a
document, agent prompt, or habit conflicts with it, this file wins and the conflicting artifact
MUST be corrected.

- **Amendments.** Amendments MUST be proposed as a change to this file, MUST state the rationale
  and the version bump, and MUST include a migration plan when they invalidate existing behavior
  or workspace state.
- **Versioning.** This constitution uses semantic versioning. MAJOR for backward-incompatible
  governance changes or principle removals and redefinitions; MINOR for a new principle or
  materially expanded guidance; PATCH for clarifications, wording, and non-semantic refinements.
- **Compliance review.** Reviews and PRs MUST verify compliance with these principles. Any
  added complexity MUST be justified against the simplest alternative that satisfies the gates.
- **Runtime guidance.** `.github/agent-instructions.md` governs agent behavior when working on
  this repository; `package/agent-instructions.md` governs agent behavior in installed
  workspaces. Both MUST remain consistent with this constitution.
- **Enforcement.** Principles I through IV are enforced in code and in the test suite. Weakening
  an enforcement point — a gate, a claim check, an independence check, or a warden boundary —
  is a MAJOR amendment, not a refactor.

**Version**: 1.0.0 | **Ratified**: TODO(RATIFICATION_DATE) | **Last Amended**: 2026-07-31
