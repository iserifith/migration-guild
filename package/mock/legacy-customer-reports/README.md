# legacy-customer-reports

`legacy-customer-reports` is a legacy reporting library whose sole reason to exist as a
fixture is a **real, compile-time Maven dependency on `legacy-customer-utils`**
(Spec 008, **US2**).

## What it does

`CustomerReportService` imports and calls `com.acme.legacy.customer.LegacyCustomerKeyService`
to build per-customer keys, then aggregates several `LegacyCustomerRecord`s into a
plain-text report. The inter-fixture `import` is a genuine source edge.

## Why this fixture exists

When both `legacy-customer-utils` and `legacy-customer-reports` are inventoried into the
same workspace, the scanner records a `source_dependencies` edge from the reports module to
the customer-utils module. The planner's parallel-pool builder must therefore place
`legacy-customer-utils` in an earlier wave than `legacy-customer-reports` — and a regression
test (`migration/test/mock-fixture-waves.test.ts`, SC-003) pins that 2+ waves are produced
with the dependency ordered first.

## Intentional legacy traits

- `com.acme.legacy.customer.*` import (the real dependency)
- `SimpleDateFormat`, raw `List`, Java 7 bytecode target
- `commons-lang` 2.6, `log4j` 1.2.17, JUnit 4

## Layout

```text
legacy-customer-reports/
  pom.xml            # <dependency> on com.acme.legacy:legacy-customer-utils
  src/main/java/com/acme/legacy/reports/...
  src/test/java/com/acme/legacy/reports/...
```
