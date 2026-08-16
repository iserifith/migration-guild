# Mock fixtures

This directory holds intentionally outdated sample projects for testing the kit.

## Fixtures

### `legacy-customer-utils/`

A small legacy Java library with a jar-style Maven layout.

It is intentionally dated in a few ways:

- Java 7 source/target
- Maven plugin versions that are behind current norms
- `commons-lang` 2.x
- `log4j` 1.x
- JUnit 4 tests
- Mutable beans, raw collections, and `SimpleDateFormat`

Because it is a library rather than a web app or service, the expected migration target is plain Java 17+ with JUnit 5.

**Pipeline concern (FR-005 baseline + inventory):** ships one JUnit 4 legacy-side test (`LegacyCustomerKeyServiceTest`) mirroring the pattern every new fixture reuses. Exercises inventory/classification of a plain `com.acme.legacy.*` Java library. Traces to pre-008 baseline; reused by the Spec 008 US2 dependent fixture.

### `legacy-python-utils/`

A tiny Python library with one module and one pytest test. It provides a marker-based fixture for exercising Python stack detection, inventory, and migration without making live model calls.

**Pipeline concern:** Python stack detection/migration marker fixture. Traces to pre-008 baseline.

### `legacy-order-view/` (Spec 008, US1)

A legacy **view-bearing** module: a Struts 1.x `Action` (`OrderViewAction`) serving two request paths (`/order/view`, `/order/submit`) that share inline validation and pricing/stock business logic, plus an `order-view.jsp` with scriptlets, `<%@` directives, and `<jsp:useBean>`.

It is **intentionally dated** so it trips the `struts-action` (`org.apache.struts.action`, `extends Action`) and `jsp-view` (`<%@`, `.jsp`) classification signals and gives the `view-regeneration-*` / `view-logic-placement-*` audit rules a real fixture to scan. It ships a JUnit 4 legacy-side test (`OrderViewActionTest`). The fixture is **solvable, not a trap**: a correct migration extracts shared validation into one `*Validator` and shared business rules into one `*Service` and yields zero view findings.

### `legacy-customer-reports/` (Spec 008, US2)

A legacy reporting library (`CustomerReportService`) whose sole fixture purpose is a **real, compile-time Maven dependency on `legacy-customer-utils`** — it imports and calls `com.acme.legacy.customer.LegacyCustomerKeyService`.

When both fixture source trees are inventoried into the same workspace, the scanner records a `source_dependencies` edge, so the planner must place `legacy-customer-utils` in an earlier wave than this module. Pinned by `migration/test/mock-fixture-waves.test.ts` (SC-003: 2+ waves, dependency ordered first). Ships a JUnit 4 legacy-side test (`CustomerReportServiceTest`).

### `legacy-modernization-bait/` (Spec 008, US3)

An **intentionally bait** legacy utility (`LegacyDateBucketUtil`) that uses outdated idioms with unambiguous modern equivalents already prescribed in `package/stacks/java-spring/mappings.md`: `SimpleDateFormat` → `java.time`; raw `Map`/`List` → generics; manual null checks → `Objects.requireNonNull`/`Optional`.

It is deliberately shaped so a shallow, rename-only migration is structurally distinguishable from a properly modernized one. **No detection rule ships with this spec** (FR-009); the fixture is the future regression target for such a rule. Ships a JUnit 4 legacy-side test (`LegacyDateBucketUtilTest`).
