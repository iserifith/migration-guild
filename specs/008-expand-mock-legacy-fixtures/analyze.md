# Analysis: Spec 008 — Expand Mock Legacy Fixtures

## Summary

Three additive `package/mock/` fixtures close the real-fixture coverage gap for the
`view-regeneration-*`/`view-logic-placement-*` audit rules (US1), multi-wave planning
(US2), and the known "renamed but not modernized" review blind spot (US3). All work is
fixture content + documentation; no core runtime is touched (FR-009 honored — see below).

## Risks

1. **US1 classification correctness.** The `jsp-view` signal matches `<%@`, `<jsp:`,
   `<%[!=]`, and the `.jspx?$` path; `struts-action` matches `org.apache.struts.action`
   and `extends (Action|DispatchAction|LookupDispatchAction)`. The fixture therefore ships
   BOTH a `.jsp` (with scriptlets) and a Struts `Action` subclass so it classifies under
   both signal families and gives the audit rules two distinct view surfaces to scan. Risk:
   if the JSP path is outside the inventoried source root, `jsp-view` may not trip. Mitigation:
   place the `.jsp` under `src/main/webapp/WEB-INF/` and confirm inventory walks web roots
   (the scanner is already proven on `legacy-customer-utils`); additionally the `.java`
   Struts action alone guarantees `struts-action`.

2. **US1 solvability.** A view module is a "trap" risk if its logic is inextricable from
   markup. The fixture keeps business logic (price calc, stock check) and validation in the
   `Action` Java code, NOT in the JSP, so a correct migration extracts them into
   `*Validator`/`*Service` modules and produces an API contract with zero `<%`/Struts/JSP
   residue → zero `view-regeneration-*` and zero `view-logic-placement-*` findings. This is
   the SC-004 "correctly-migrated" case. The deliberately-inlined/bait variant for exercising
   the findings remains in the audit rules' own unit-test suite (already exists per changelog),
   not as committed fixture output.

3. **US2 wave ordering.** `buildParallelPools` derives levels from the `source_dependencies`
   graph built by `extractSourceDependencies`. The dependent fixture MUST `import` a type from
   `legacy-customer-utils` (compile-time edge) so a real `scanAndRegister` produces the link.
   The regression test copies both real fixture source trees into a temp `legacy/` workspace,
   runs the actual scanner, and asserts 2+ pools with the dependency draining first — so the
   test reflects real engine behavior, not a hand-fed graph.

4. **SC-002 sizing.** Combined added fixture lines are kept well under ~1,500 (target ≈ 700–900
   incl. README/docs), so the full mock pipeline run stays a fast smoke test.

## Known gap — Story 3 detection rule (explicitly out of scope)

No automated "shallow, renamed-only, not-really-modernized" detection exists yet (spec
Assumptions + FR-009). This spec builds ONLY the bait fixture. The fixture's legacy code uses
`SimpleDateFormat`, raw `Map`/`List`, and manual null checks — each with an unambiguous
modern equivalent already in `package/stacks/java-spring/mappings.md` (`java.time`, generics,
`Objects.requireNonNull`). A low-effort "migration" that copies the body and renames identifiers
leaves the outdated idioms in place and is structurally distinguishable from a properly
modernized version. User Story 3, Scenario 3 documents this gap as currently open; once the
detection rule ships, this fixture becomes its regression target. We do NOT add the rule here.

## FR-009 honoring (no core runtime change)

- No files under `migration/registry/**` or `migration/guildctl/**` runtime modified except the
  additive regression test under `migration/test/`.
- No changes to the audit-rule engine or `audit.rules.yaml`.
- No new stack pack or classification signal; `classification.yaml` is read-only.
- `legacy-customer-utils/` and `legacy-python-utils/` untouched (FR-007).

## Fixture sizing vs SC-002 (estimate)

| Fixture | Files | Est. lines |
| --- | --- | --- |
| `legacy-order-view` (US1) | 5 (+pom/jsp/test/readme) | ~280 |
| `legacy-customer-reports` (US2) | 4 | ~120 |
| `legacy-modernization-bait` (US3) | 4 | ~130 |
| README + docs | — | ~200 |
| **Total** | | **~730** (well under 1,500) |
