# Plan: Spec 008 — Expand Mock Legacy Fixtures

**Status:** Ready for implementation
**Spec:** `specs/008-expand-mock-legacy-fixtures/spec.md`
**Branch:** `claude/migration-planning-modernization-tmzff3` (detached HEAD at tip "Add spec 008")
**Constraint summary:** fixture content + documentation ONLY. No edits to core runtime (registry, claims, evidence gates, arbitration, audit-rule engine). No edits to existing `legacy-customer-utils/` / `legacy-python-utils/`.

## Goal

Add three additive `package/mock/` sibling fixtures so the pipeline's newest gates and blind spots get real coverage:

- **US1 (P1)** — a view-bearing legacy module (Struts action + embedded validation/business logic across 2+ request paths) exercising `view-regeneration-*` and `view-logic-placement-*` end-to-end; solvable end-to-end; zero view findings when migrated correctly.
- **US2 (P2)** — a fixture with a REAL Maven compile-time dependency on `legacy-customer-utils`, so `guildctl plan` yields 2+ waves with the dependency ordered first.
- **US3 (P2)** — a "verbatim-copy bait" fixture using outdated idioms (`SimpleDateFormat`, raw `Map`/`List`, manual null checks) that `package/stacks/java-spring/mappings.md` already prescribes modern replacements for. No detection rule is built.

## Governing constraints (from constitution + spec)

- **FR-007** — additive sibling dirs only; existing fixtures untouched.
- **FR-008** — java-spring stack pack only; no new stack pack or classification signal.
- **FR-009** — NO core runtime change; fixture content + docs only. (Honored — see "Out of scope".)
- **FR-005** — every new fixture ships its own legacy-side JUnit 4 test mirroring `LegacyCustomerKeyServiceTest.java`.
- **SC-002** — total added fixture size < ~1,500 lines combined.
- **Principle V** — tests before production code; write legacy-side tests first.

## Inventory / classification contract (how fixtures get inventoried)

Existing `legacy-customer-utils` lives at `package/mock/legacy-customer-utils/...` with `com.acme.legacy.*` packages and is the proven pattern. New Java fixtures MUST follow its exact layout:

- `pom.xml` (jar packaging, JUnit 4, `maven.compiler.source/target` 1.7, `commons-lang` 2.6, `log4j` 1.2.17) — see `package/mock/legacy-customer-utils/pom.xml`.
- Source root `src/main/java/com/acme/legacy/<story>/...`, tests `src/test/java/com/acme/legacy/<story>/...`.
- US1 must trip `jsp-view`/`struts-action` regexes in `package/stacks/java-spring/classification.yaml`: include a `.jsp`/`.jspx`/`.jsp`-embedded scriptlet and `org.apache.struts.action` import / `extends Action` so it classifies with view signals.
- The multi-wave test (SC-003) exercises the real engine: copy the `legacy-customer-utils` source + the new dependent fixture source into a temp `legacy/` workspace, `scanAndRegister`, then `buildParallelPools` — asserting 2+ pools with the dependency draining first. This reuses the established `source-deps-pools.test.ts` pattern and never mutates existing fixtures.

## Phased plan

### Phase 0 — Setup (docs first)
- Create `specs/008-expand-mock-legacy-fixtures/plan.md` (this file).
- Create `specs/008-expand-mock-legacy-fixtures/tasks.md`.
- Create `specs/008-expand-mock-legacy-fixtures/analyze.md`.

### Phase 1 — US1: view-bearing fixture (P1, MVP)
- `package/mock/legacy-order-view/pom.xml` — jar, junit4, struts + servlet deps (kept intentionally dated: struts 1.x, servlet 2.4).
- `package/mock/legacy-order-view/src/main/java/com/acme/legacy/order/OrderViewAction.java` — `extends org.apache.struts.action.Action`, two request paths (`view` / `submit`) sharing validation + business logic (price calc, stock check) with inline `ActionMessages` validation and embedded business rules.
- `package/mock/legacy-order-view/src/main/java/com/acme/legacy/order/Order.java` — mutable record (raw collections, `Date`).
- `package/mock/legacy-order-view/src/main/webapp/WEB-INF/order-view.jsp` — JSP with `<%@`, scriptlets, `<jsp:useBean>` so `jsp-view` signal fires.
- `package/mock/legacy-order-view/src/test/java/com/acme/legacy/order/OrderViewActionTest.java` — JUnit 4, mirrors `LegacyCustomerKeyServiceTest` (asserts validation rejection + business output).
- `package/mock/legacy-order-view/README.md`.
- **Why solvable:** logic is separable; a correctly-migrated output lands an API contract with `*Validator`/`*Service` and NO `<%`/`javax.faces`/Struts imports → zero view findings.

### Phase 2 — US2: dependent fixture (P2)
- `package/mock/legacy-customer-reports/pom.xml` — jar, with `<dependency>` on `com.acme.legacy:legacy-customer-utils` (version matching existing `0.9.3-SNAPSHOT`).
- `package/mock/legacy-customer-reports/src/main/java/com/acme/legacy/reports/CustomerReportService.java` — imports `com.acme.legacy.customer.LegacyCustomerKeyService` and calls it, producing a report string. Real compile-time edge → source-dependency link.
- `package/mock/legacy-customer-reports/src/test/java/com/acme/legacy/reports/CustomerReportServiceTest.java` — JUnit 4.
- `package/mock/legacy-customer-reports/README.md`.

### Phase 3 — US3: verbatim-copy bait fixture (P2)
- `package/mock/legacy-modernization-bait/pom.xml` — jar, junit4 (intentionally dated).
- `package/mock/legacy-modernization-bait/src/main/java/com/acme/legacy/bait/LegacyDateBucketUtil.java` — uses `SimpleDateFormat`, raw `Map`/`List`, manual null checks. Each idiom maps to a prescribed modern equivalent in `mappings.md` (`SimpleDateFormat`→`java.time`; raw collections→generics).
- `package/mock/legacy-modernization-bait/src/test/java/com/acme/legacy/bait/LegacyDateBucketUtilTest.java` — JUnit 4 behavior baseline.
- `package/mock/legacy-modernization-bait/README.md`.
- **Detection gap documented:** no rule built (FR-009). The fixture's value today is manual review + future detection-rule regression target.

### Phase 4 — README + docs
- Update `package/mock/README.md` (FR-006): document ALL four fixtures (existing 2 + new 3) with pipeline concern, "intentionally dated"/"intentionally bait" traits, story/spec trace.

### Phase 5 — Regression test (SC-003)
- `migration/test/mock-fixture-waves.test.ts` — copies `package/mock/legacy-customer-utils` + `package/mock/legacy-customer-reports` into a temp `legacy/` project, runs `scanAndRegister` + `buildParallelPools`, asserts 2+ pools and that the dependency (`legacy-customer-utils`) drains in an earlier pool than the dependent. Reuses `source-deps-pools.test.ts` imports. Does NOT change assertions about existing fixtures.

### Phase 6 — Changelog + quality gate
- Add `CHANGELOGS.MD` `Unreleased` entry under an August 16, 2026 heading.
- Confirm `DEVELOPMENT.md` maintainer checklist satisfied (repo-only fixture content + docs; `package/` mock dirs added; `migration/` test added; `CHANGELOGS.MD` updated).
- Run `npm install` then `npm test`; must pass.

## MVP vs incremental boundaries

- **MVP** = Phase 0 docs + US1 (P1, the biggest coverage gap) + US2 (P2, required for SC-003) + README + regression test. This alone satisfies SC-001/SC-003/SC-005 and is approvable.
- **Incremental** = US3 bait fixture (P2) is separable and additive; added after MVP but before the quality gate so all three stories ship together.

## Out of scope (explicit FR-009 honoring)

- No changes to `migration/registry/**`, `migration/guildctl/**` runtime, audit-rule engine, registry, claims, evidence, arbitration.
- No new audit rule for Story 3's shallow-migration detection (documented as a known gap in analyze.md).
- No new stack pack or classification signal added to `package/stacks/java-spring/`.

## Verification

- `cd <worktree> && npm install` (first time).
- `npm test` — MUST pass (migration suite + Mission Control UI suite).
- Sanity: confirm US1 legacy files would trip `jsp-view` (`<%@`,`.jsp`) and `struts-action` (`org.apache.struts.action`, `extends Action`) regexes in `classification.yaml`.
- Confirm `tasks.md` boxes are marked as completed; incomplete items reported.
