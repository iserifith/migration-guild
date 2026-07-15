# Autonomous Migration Canary Implementation Plan

> **For Hermes:** Execute this plan with strict TDD, independent review, and real canary evidence.

**Goal:** Make Migration Guild ready for a bounded unattended migration run by implementing the minimum deterministic supervisor, runtime evidence gate, filesystem warden, failure/repair loop, and safe Rootsys launch path.

**Architecture:** Keep SQLite as the sole source of truth. A TypeScript `guildctl auto` controller advances one claimed artifact through migrate → verify → repair → reverify → review/arbitrate. Agents may propose or edit, but only runner-owned tokens, verifier-generated evidence, claim constraints, and warden-clean filesystem state can advance the artifact.

**Tech Stack:** TypeScript, Node test runner, SQLite/better-sqlite3, existing Guild registry and `AGENT_CMD` harness.

---

## Current baseline

- Branch starts from `b57ed8f`, including TASK-05 and TASK-10.
- Existing full suite passes.
- Original checkout remains dirty only at `guildctl.config.json`; this worktree is isolated and clean.
- Rootsys `/v1/models` advertised 14 models and all 14 returned a real completion.
- No `auto`, `verify`, or `warden` implementation exists at baseline.

## Task 1 — Identity and claim boundary hardening

**Files:**
- Modify `migration/registry/commands/artifacts.ts`
- Modify `migration/registry/commands/claim.ts`
- Modify relevant CLI/types modules
- Test `migration/test/actor-token.test.ts`

**Requirements:**
1. Write failing tests proving a caller cannot bypass claim-token checks by naming itself `operator`, `remediation-agent`, or `guildctl`.
2. Add a runner-held operator credential bound to a run, never exported to workers.
3. Require either the artifact-bound active claim token or valid run operator credential for privileged mutations.
4. Enforce at most one active claim per run.
5. Preserve existing manual workflows through explicit trusted CLI paths rather than role-name spoofing.

## Task 2 — Runtime verifier and unforgeable approval gate

**Files:**
- Create `migration/guildctl/verify.ts` and/or `migration/guildctl/commands/verify.ts`
- Modify `migration/guildctl/cli.ts`
- Modify `migration/registry/commands/evidence.ts`
- Modify stack configuration types/loading as minimally necessary
- Test `migration/test/evidence-runtime.test.ts`

**Requirements:**
1. Write failing fixture tests for build pass and build fail.
2. `guildctl verify --artifact <id>` executes actual configured commands in the target workspace.
3. Capture command, exit code, duration, log path, SHA-256, and verifier-owned authenticity data.
4. Reject direct caller creation of approvable `runtime` evidence.
5. Arbitration accepts only verifier-generated passing runtime evidence.
6. Existing legacy evidence remains readable but cannot newly approve autonomous work.
7. Keep secrets outside logs and agent environments.

## Task 3 — Filesystem warden

**Files:**
- Create `migration/guildctl/warden.ts`
- Modify `migration/guildctl/runner.ts`
- Test `migration/test/warden.test.ts`

**Requirements:**
1. Test first with a fake `AGENT_CMD` that edits allowed and forbidden files.
2. Snapshot SHA-256 and bytes before spawn.
3. Compare post-run changes against claim/pool allowed paths.
4. Restore unauthorized writes/deletions exactly.
5. Emit a violation event and prevent phase advancement.
6. Keep the registry and orchestration files outside worker write scope.

## Task 4 — Failure taxonomy and bounded repairs

**Files:**
- Create `migration/guildctl/supervisor/failures.ts`
- Create supporting diagnosis/budget modules only if necessary
- Test `migration/test/supervisor-failures.test.ts`

**Requirements:**
1. Deterministically classify build failure, test failure, agent timeout, filesystem violation, claim violation, stack mismatch, pack defect, provider error, and unknown.
2. Normalize failure signatures.
3. Bound attempts to three per artifact and two repairs per matching failure by default.
4. Never repeat the same failed playbook against the same signature more than twice.

## Task 5 — Single-artifact autonomous supervisor

**Files:**
- Create `migration/guildctl/commands/auto.ts`
- Create `migration/guildctl/supervisor/loop.ts`
- Modify `migration/guildctl/cli.ts`
- Test `migration/test/auto-canary.test.ts`

**Requirements:**
1. Test first with a scripted fake worker.
2. Drive one explicit artifact through claim → migrate → verify.
3. On verification failure, capture evidence, classify, run a fresh repair worker, and reverify.
4. Continue to review/arbitrate only after real verifier evidence and clean warden result.
5. Store every transition as registry events so `--resume` derives state from SQLite rather than memory.
6. On budget exhaustion, leave the artifact blocked with evidence and no active orphan claim.
7. Existing manual commands remain unchanged.

## Task 6 — Safe provider handoff and provisional routing

**Files:**
- Modify configuration loader/harness only as required
- Add documentation/example configuration without secrets
- Test environment precedence and redaction

**Requirements:**
1. Never persist the Rootsys key in repository files.
2. Allow the runner process to receive `ROOTSYS_API_KEY` from a trusted launcher/environment.
3. Configure provisional chains:
   - default: `fiq/hy3-tencent`, `fiq/deepseek-v4-pro`, `fiq/grok-4.5`
   - census: `fiq/deepseek-v4-flash`, `fiq/minimax-m3`
   - review: `fiq/gpt-5.5-review`, `fiq/glm-5.2`
4. Fail closed with a credential preflight before a live run.

## Task 7 — Verification and readiness canaries

1. Run targeted RED/GREEN tests for every task.
2. Run `npm test` and `npm --prefix migration run build`.
3. Run a scripted fake-agent canary that intentionally emits broken code on attempt one and repairs it on attempt two.
4. Verify: real failure detected, repair triggered, verification passes, no unauthorized files survive, one claim owner throughout, terminal registry state, replayable events.
5. Run an independent spec and security/code-quality review and patch all blocking findings.
6. Commit verified implementation.
7. Only then run one bounded live Rootsys artifact canary in a fresh external workspace. Do not run phases against the kit repository root.

## Migration-ready gate

Declare ready only if all are true:

- Full test/build green.
- Fake stop→repair→resume canary green.
- No active orphan claims.
- Runtime evidence cannot be forged through the public CLI.
- Out-of-scope writes are restored and block advancement.
- Live Rootsys credential preflight passes without logging the key.
- One live bounded artifact canary reaches its expected terminal state or produces a mechanically valid blocked packet without human steering.
