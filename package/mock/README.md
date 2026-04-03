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
