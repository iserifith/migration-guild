# legacy-modernization-bait

`legacy-modernization-bait` is an **intentionally bait** legacy utility (Spec 008, **US3**).
It uses outdated Java idioms whose modern replacements are already prescribed in
`package/stacks/java-spring/mappings.md` — but NO detection rule ships with this spec.

## What it does

`LegacyDateBucketUtil` buckets dates by day, formats/tolerates nulls, and sums amounts by
bucket. Functionally trivial; its value is the *shape* of the code.

## Why this fixture exists

A shallow, rename-only "migration" that copies the method bodies and renames identifiers
leaves the outdated idioms in place. A properly modernized version replaces them. The two are
therefore **structurally distinguishable**:

| Outdated idiom (present here) | Modern equivalent (in mappings.md) |
| --- | --- |
| `SimpleDateFormat` in shared state | `java.time` (`DateTimeFormatter`) |
| raw `Map` / `List` (no generics) | parameterized types |
| manual `null` checks / nullable returns | `Objects.requireNonNull` / `Optional` |

## Known gap (open)

No automated "renamed-but-not-modernized" detection rule exists yet (spec Assumptions +
FR-009). This fixture is the future regression target for such a rule; it does NOT ship one.
Until then the distinction is caught by manual review, not the pipeline.

## Intentional legacy traits

- `SimpleDateFormat`, raw collections, manual null handling, Java 7 bytecode target
- `commons-lang` 2.6, JUnit 4

## Layout

```text
legacy-modernization-bait/
  pom.xml
  src/main/java/com/acme/legacy/bait/LegacyDateBucketUtil.java
  src/test/java/com/acme/legacy/bait/LegacyDateBucketUtilTest.java
```
