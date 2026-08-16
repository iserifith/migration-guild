# Tasks: Spec 008 — Expand Mock Legacy Fixtures

Format: `- [ ] [T###] [P?] [US#?] description (path)`

Scope: additive `package/mock/` fixtures + docs + one regression test. No core runtime change (FR-009).

## Setup / Spec Kit docs (Phase 0)

- [x] [T001] [P1] [US1] Write plan.md (specs/008-expand-mock-legacy-fixtures/plan.md)
- [x] [T002] [P1] [US1] Write tasks.md (specs/008-expand-mock-legacy-fixtures/tasks.md)
- [x] [T003] [P1] [US1] Write analyze.md (specs/008-expand-mock-legacy-fixtures/analyze.md)

## US1 — view-bearing fixture (P1, MVP)

- [x] [T010] [P1] [US1] Create `legacy-order-view/pom.xml` (jar, junit4, struts 1.x + servlet 2.4, intentionally dated) (package/mock/legacy-order-view/pom.xml)
- [x] [T011] [P1] [US1] Write `Order.java` mutable record with raw collections + `Date` (package/mock/legacy-order-view/src/main/java/com/acme/legacy/order/Order.java)
- [x] [T012] [P1] [US1] Write `OrderViewAction.java` Struts action: `extends org.apache.struts.action.Action`, two request paths (`view`/`submit`) sharing inline validation + business logic (price calc, stock check) (package/mock/legacy-order-view/src/main/java/com/acme/legacy/order/OrderViewAction.java)
- [x] [T013] [P1] [US1] Write `order-view.jsp` with `<%@`, scriptlets, `<jsp:useBean>` so jsp-view signal fires (package/mock/legacy-order-view/src/main/webapp/WEB-INF/order-view.jsp)
- [x] [T014] [P1] [US1] Write `OrderViewActionTest.java` JUnit 4 legacy-side test mirroring LegacyCustomerKeyServiceTest pattern (package/mock/legacy-order-view/src/test/java/com/acme/legacy/order/OrderViewActionTest.java)
- [x] [T015] [P1] [US1] Write `legacy-order-view/README.md` (package/mock/legacy-order-view/README.md)

## US2 — dependent fixture (P2, MVP; required for SC-003)

- [x] [T020] [P2] [US2] Create `legacy-customer-reports/pom.xml` with real `<dependency>` on `com.acme.legacy:legacy-customer-utils` (package/mock/legacy-customer-reports/pom.xml)
- [x] [T021] [P2] [US2] Write `CustomerReportService.java` importing and calling `LegacyCustomerKeyService` (real compile-time edge) (package/mock/legacy-customer-reports/src/main/java/com/acme/legacy/reports/CustomerReportService.java)
- [x] [T022] [P2] [US2] Write `CustomerReportServiceTest.java` JUnit 4 legacy-side test (package/mock/legacy-customer-reports/src/test/java/com/acme/legacy/reports/CustomerReportServiceTest.java)
- [x] [T023] [P2] [US2] Write `legacy-customer-reports/README.md` (package/mock/legacy-customer-reports/README.md)

## US3 — verbatim-copy bait fixture (P2, incremental)

- [x] [T030] [P2] [US3] Create `legacy-modernization-bait/pom.xml` (jar, junit4, intentionally dated) (package/mock/legacy-modernization-bait/pom.xml)
- [x] [T031] [P2] [US3] Write `LegacyDateBucketUtil.java` using `SimpleDateFormat`, raw `Map`/`List`, manual null checks — idioms mapped to modern equivalents in mappings.md (package/mock/legacy-modernization-bait/src/main/java/com/acme/legacy/bait/LegacyDateBucketUtil.java)
- [x] [T032] [P2] [US3] Write `LegacyDateBucketUtilTest.java` JUnit 4 legacy-side test (package/mock/legacy-modernization-bait/src/test/java/com/acme/legacy/bait/LegacyDateBucketUtilTest.java)
- [x] [T033] [P2] [US3] Write `legacy-modernization-bait/README.md` noting the open detection-rule gap (package/mock/legacy-modernization-bait/README.md)

## Documentation updates (Phase 4)

- [x] [T040] [P1] [US1] Update `package/mock/README.md` to document ALL four fixtures (existing 2 + new 3) per FR-006 (package/mock/README.md)

## Regression test (SC-003, Phase 5)

- [x] [T050] [P2] [US2] Add `migration/test/mock-fixture-waves.test.ts`: copy legacy-customer-utils + legacy-customer-reports into a temp legacy/ project, scanAndRegister, buildParallelPools, assert 2+ pools with dependency draining first (migration/test/mock-fixture-waves.test.ts)

## Quality gate / changelog (Phase 6)

- [x] [T060] [P1] [US1] Add `CHANGELOGS.MD` Unreleased entry under August 16, 2026 heading (CHANGELOGS.MD)
- [x] [T061] [P1] [US1] Confirm DEVELOPMENT.md maintainer checklist satisfied; run `npm install` then `npm test` and ensure green (repo root)
- [x] [T062] [P1] [US1] Commit specific files (detached HEAD, no push) (git)
