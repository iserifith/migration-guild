# Contract: CLI / Environment Surface

**Feature**: `005-artifact-risk-scoring`

Operator-facing and automation-facing surface changes. Follows the existing
`GUILDCTL_AUTO_CONFIRM_MAPPINGS` / `GUILDCTL_AUTO_APPROVE_DEPENDENCIES` /
`GUILDCTL_AUTO_KEEP_SCOPE` precedent exactly (env-var only, no new CLI flag — see
`../research.md` §5 for why parity with that precedent, not a new flag, is the
contract).

## New environment variable: `GUILDCTL_AUTO_CONFIRM_RISK`

| | |
|---|---|
| Values | `"1"` to enable; unset/anything else means "off" |
| Read by | new `confirmHighRiskArtifacts` function in `migration/guildctl/commands/plan.ts`, at the same point `confirmMappings`/`GUILDCTL_AUTO_CONFIRM_MAPPINGS` is read |
| Effect when `"1"` | every `risk_confirmations` row currently `pending` is bulk-updated to `decision='confirmed', decided_by='benchmark-runner', decided_at=datetime('now')`, no prompt shown |
| Effect when unset | interactive `readline` prompt per pending high-risk artifact (confirm/decline), identical shape to `confirmMappings`'s y/n loop; if stdin is not interactive (e.g. CI without a TTY and the var unset), pending artifacts simply remain `pending` — they are not claimable (see `contracts/registry-schema.md`'s claim-eligibility contract), satisfying FR-012's "no silent bypass" without hanging the process |
| Set by | benchmark/test harnesses only, exactly like the three existing `GUILDCTL_AUTO_*` vars (`migration/guildctl/commands/benchmark.ts`, and module-scope `process.env[...] = "1"` in relevant `migration/test/*.test.ts` files) |

**No new CLI flag is introduced.** This is a deliberate parity decision: none of the
three existing analogous gates (`GUILDCTL_AUTO_CONFIRM_MAPPINGS`,
`GUILDCTL_AUTO_APPROVE_DEPENDENCIES`, `GUILDCTL_AUTO_KEEP_SCOPE`) expose a `guildctl
plan --auto-confirm-*` flag; adding one only for risk would break the established
"benchmark/CI env-var, interactive-by-default otherwise" convention for no stated
requirement in the spec.

## Existing CLI commands affected (behavior change, no signature change)

- `guildctl inventory` (`migration/guildctl/cli.ts`): after registering and
  classifying artifacts, now also computes and persists risk assessments as part of
  the same phase. No new flags. Output gains a summary line (count of high-risk
  artifacts flagged), following the existing "silence-first, one final summary"
  convention (Principle VI).
- `guildctl plan` (`migration/guildctl/cli.ts`): after the Planner agent phase
  (Phase 2b) completes, runs the new `confirmHighRiskArtifacts` step before the
  command exits. No new flags; existing `--override-audit`, `--retries`,
  `--enforce-invariants` are unaffected and orthogonal to this gate.

## Registry-level query surface (for operators/tooling, not a new CLI subcommand)

Existing precedent (`registry` CLI, `migration/registry/cli.ts`) exposes read
commands like `list-jvm-findings`/`findings`. This feature's read surface is satisfied
by direct SQL against the new tables (documented in `contracts/registry-schema.md`) —
consistent with how `artifact_classifications` has no dedicated `list-classifications`
CLI command either; operators/tooling query the registry file directly (`sqlite3
<db> "SELECT ... FROM artifact_risk_assessments"`) or through
`migration/registry/commands/queries.ts`-style helper functions if a query surface is
needed by the UI package. Whether a first-class CLI/registry query command is worth
adding is an implementation-time (`tasks.md`) decision, not a plan-phase requirement —
`FR-006`/`SC-001` only require registry-visibility, not a specific query command.
