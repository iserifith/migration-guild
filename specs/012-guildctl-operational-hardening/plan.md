# Implementation Plan: guildctl Operational Hardening

**Branch**: `012-guildctl-operational-hardening` | **Date**: 2026-08-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-guildctl-operational-hardening/spec.md`

## Summary

Nine independent, evidence-grounded bug fixes to the `guildctl` CLI and its supporting registry/supervisor code, closing GitHub issues #150, #151, #153–#159. The common thread is operational correctness: the tool must do what it already claims to do (manual arbitration, stack-aware verification, clean CLI errors, accurate evidence bookkeeping, bounded concurrency, correct paths, accurate preflight signal, a workable default config, and a truthful headless setup fallback) rather than gaining new capability. Each fix is scoped to the exact file(s) the corresponding issue already identified; no shared new abstraction is introduced across fixes beyond one new small primitive (a verify-slot lease) that intentionally mirrors an existing pattern (artifact claims).

## Technical Context

**Language/Version**: TypeScript 6.x, compiled via `tsc`/`tsup`, run on Node.js (ESM/CJS mixed per package) — matches existing `migration/` and root `package.json` toolchains.

**Primary Dependencies**: `commander` (CLI parsing, `migration/guildctl/cli.ts`), `better-sqlite3` (registry, WAL mode), `yaml` (stack pack parsing), `dotenv` (env/config loading). No new runtime dependency is required by any of the nine fixes.

**Storage**: SQLite registry database (`registry.db`, `better-sqlite3`), accessed exclusively through `migration/registry/commands/*`. The new verify-slot lease (US5/#151) is a new table in this same database, following the existing `claim`/`run_operator_credentials` table pattern.

**Testing**: `node --import tsx --test test/*.test.ts` (`migration/` suite) plus the Mission Control UI suite (`migration/ui`), run together via root `npm test`. Per the constitution, kit-behavior changes (claims, evidence gates, arbitration, warden scope, phase control flow — which covers 7 of the 9 fixes here) MUST ship with regression tests in this suite.

**Target Platform**: Cross-platform CLI (Linux/macOS/Windows dev and CI hosts) invoking `guildctl`/`guild` as a Node binary; no server/browser runtime involved for these fixes (the Mission Control UI is untouched).

**Project Type**: Single-repo CLI + library tool with a plugin-style stack-pack layer (`stacks/`) and a shipped agent/prompt package (`package/`). Not a web or mobile app; no frontend/backend split applies.

**Performance Goals**: Not throughput-sensitive. The one quantitative target is US5/#151's concurrency cap: verify subprocess fan-out must be bounded by a configurable `verification.max_concurrent` (sensible default such as `os.cpus().length`, floor of 1) rather than growing unbounded with session count.

**Constraints**: Every fix MUST preserve, not weaken, the constitution's enforcement points — in particular Principle I (Evidence Over Assertion), Principle III (registry-mediated coordination via claims/credentials), Principle IV (builder/critic/arbiter separation), and Principle VI (fail-closed automation). Principle VII requires stack-specific knowledge (US2/#154's verify-command fix) to stay resolved through the existing stack-pack interface, not hardcoded per-stack logic in core runtime code.

**Scale/Scope**: Nine independently deployable fixes touching: `migration/guildctl/cli.ts`, `migration/guildctl/commands/{arbitrate,verify,auto,auto-run}.ts`, `migration/guildctl/supervisor/loop.ts`, `migration/guildctl/{verify,preflight}.ts`, `migration/registry/commands/{evidence,claim}.ts`, `stacks/java-spring/stack.yaml`, `package/agents/*.agent.md`, `package/prompts/*.md`, `setup.ts`, `GETTING-STARTED.md`/`README.md`, plus new/extended tests under `migration/test/`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| I. Evidence Over Assertion | **Strengthens.** US4/#156 closes a real gap (warden-reverted output still counting as `migrated`); US1/#153 makes the arbitration gate actually reachable for manual evidence review instead of dead code. No gate is loosened. |
| II. Legacy Read-Only / `modern/` Only Write Target | **Unaffected.** No fix touches warden write-scope rules themselves; US4 only prevents a false-success status *after* the warden has already correctly enforced this principle. |
| III. Registry-Mediated Coordination | **Strengthens.** US1 makes manual approval go through the same `run_operator_credentials` mechanism auto-mode already uses (no bypass introduced — an ad-hoc run+credential is minted through the existing `createRunOperatorCredential`, not a new bypass path). US5 extends the existing claim/lease pattern to verify subprocesses rather than inventing a new coordination mechanism. |
| IV. Separation of Powers | **Unaffected in substance.** US1 does not change who may approve; it only makes the existing independence check (`assertApprovalEvidenceIsIndependent`) reachable outside `auto`. |
| V. Tests Before Production Code | **Applies to this feature's own delivery.** Per Development Workflow gates, each fix that touches claims/evidence/arbitration/warden/phase-control-flow (US1, US2, US4, US5) ships with a `migration/test` regression test before/with the corresponding production change. |
| VI. Fail-Closed Automation | **Strengthens.** US2's blocked-loop hard-stop and US3's clean resume failure both replace "guess/crash" behavior with an explicit halt-and-surface, which is exactly what this principle requires. |
| VII. Pluggable Stacks, Neutral Providers | **Strengthens.** US2 fixes verify-command resolution to actually consult the stack pack's `per_artifact` config (already the sanctioned mechanism) instead of a hardcoded `npm test` default in `migration/guildctl/commands/{verify,auto}.ts` — this removes a Principle VII violation rather than introducing one. |

No violations requiring justification. Complexity Tracking table is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/012-guildctl-operational-hardening/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md         # Phase 1 output ($speckit-plan command)
├── quickstart.md         # Phase 1 output ($speckit-plan command)
├── contracts/             # Phase 1 output ($speckit-plan command)
│   └── cli-commands.md
└── tasks.md              # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/
├── guildctl/
│   ├── cli.ts                       # US1: arbitrate flags + clean RegistryError catch; US3: resume clean-catch
│   ├── preflight.ts                 # US7: max_tokens probe fix
│   ├── verify.ts                    # US5: acquire/release verify slot around executeCheck's spawn()
│   ├── supervisor/loop.ts           # US2: blocked-loop hard-stop after remediation confirms no defect
│   ├── stack.ts                     # US2: verify-command resolution reads from stack pack (already the intended path)
│   └── commands/
│       ├── arbitrate.ts             # US1: pass --run-id/--operator-token through
│       ├── verify.ts, auto.ts       # US2: replace hardcoded "npm test" fallback with stack-resolved default
│       ├── auto.ts                  # US3: --resume handling for `blocked` status
│       ├── migrate.ts               # US4: warden-revert must not leave status=migrated
│       └── plan.ts                  # US6: fix stale migration/dist/... path in blocked-dispositions message
├── registry/commands/
│   ├── evidence.ts                  # US1: manual approval path already exists here; wire CLI flags to it
│   └── claim.ts                     # US5: new verify_slot lease table + acquire/release functions, mirroring claim/lease
└── test/                            # regression tests for US1, US2, US4, US5 (Principle V gate)

stacks/java-spring/stack.yaml        # US5: add -J-Xmx bound to javac verify args

package/
├── agents/*.agent.md                # US6: fix stale migration/dist/... path in test-writer-agent self-claim fallback
└── prompts/*.md                     # US6: same stale-path sweep

setup.ts                             # US9: non-TTY stdin handling in runInstall()/ask()
GETTING-STARTED.md, README.md        # US6 (n/a here), US8 (init/auto DB-path constraint), US9 (correct the stdin-fallback claim)
```

**Structure Decision**: No new top-level directories or projects. This is a single existing CLI/library repo (`migration/` = registry + guildctl runtime, `package/` = shipped agent/prompt/stack content, `stacks/` = pluggable stack packs, root = installer). Every fix lands inside the directory the corresponding GitHub issue already pointed at; the only new code unit is the verify-slot lease (a new table + a pair of functions in `registry/commands/claim.ts`, following the file's existing claim/lease pattern), not a new module or service boundary.

## Complexity Tracking

*No entries — Constitution Check found no violations requiring justification.*
