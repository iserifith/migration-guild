# Quickstart: Validate View-Logic Consolidation

Runnable validation scenarios proving the placement requirement end-to-end. Per the
constitution, validation happens in a **fresh migration workspace outside this repository**
(using `package/mock/` or operator-supplied legacy code) — never against the repo root.

## Prerequisites

- Kit installed into a scratch workspace (`guildctl setup` per GETTING-STARTED.md).
- The java-spring stack pack active (`.guild/config.yaml` → `stack: java-spring`).
- Legacy fixture: at least one view-handling module carrying non-trivial validation and
  business logic (e.g. a Struts action with request validation + business rules, or a
  JSP-backed controller with embedded decision logic). `package/mock/` sample content or a
  hand-written fixture works.

## Scenario 1 — Consolidated extraction (spec Story 1, SC-001/SC-002)

1. Place the legacy view-handling fixture under `legacy/`; run inventory, plan, and migrate
   the artifact per the normal pipeline.
2. Inspect the resulting `modern/` tree:
   - Validation logic from the legacy module lives in a dedicated `*Validator` class.
   - Business logic lives in a dedicated `*Service` class.
   - The contract-backed endpoint/handler contains only routing, parameter binding,
     delegation to the `*Service`/`*Validator`, and response shaping.
   - Where several endpoints back the same migrated view module, all use the **same**
     service/validator — no copied rule blocks.
3. Expected outcome: mapping rule satisfied; no placement findings in Scenario 2.

## Scenario 2 — Audit catches an inlined handler (spec Story 2, SC-003)

1. In the same workspace, deliberately inline: edit (or hand-author) a handler backing a
   migrated view module so it carries non-trivial validation/business logic inline with no
   `*Service`/`*Validator` collaborator.
2. Run the post-migration audit (`/prompt post-migration-audit` or the `audit-agent`).
3. Expected outcome: a placement finding is reported identifying the offending handler, the
   rule that fired (`view-logic-placement-*`), severity, and remediation directing extraction
   into a dedicated module — in the same structured form as other audit findings, with a
   registry remediation entry (`category "view-logic-placement"`).
4. Revert the inline change (restore the consolidated form from Scenario 1) and re-run the
   audit. Expected outcome: zero placement findings — no false positives on consolidated
   output.

## Scenario 3 — Review checklist flags placement (spec Story 3, SC-004)

1. Run `/migration-review` (or the `review-agent`) against the inlined handler from
   Scenario 2.
2. Expected outcome: the checklist's placement item leads the reviewer to record the inlined
   logic as a **Critical** finding (handler must only delegate), not approve it.
3. Run the same review against the consolidated output from Scenario 1. Expected outcome: the
   placement item passes alongside the existing "no regenerated UI" checks.

## Scenario 4 — Kit regression suite (constitution V)

1. From a kit checkout: `npm test` (runs `node --import tsx --test migration/test/*.test.ts`).
2. Expected outcome: `audit-view-logic-placement.test.ts` passes — positive detection on an
   inlined-handler fixture, zero findings on a consolidated fixture — and
   `stack-pack-engine.test.ts` passes with the updated rule count and `logic_extraction`
   manifest assertions.

## References

- Data model and entity shapes: [data-model.md](./data-model.md)
- Pack declaration contract: [contracts/logic-extraction-declaration.md](./contracts/logic-extraction-declaration.md)
- Audit rule contract: [contracts/audit-placement-rules.md](./contracts/audit-placement-rules.md)
