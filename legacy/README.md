# legacy-customer-utils

`legacy-customer-utils` is a tiny legacy library fixture used to exercise inventory, planning, and migration flows.

## What it does

The library builds customer keys from mutable record objects and region prefix configuration stored in a properties file.

Example output:

`NEA-smith-anna-20140315-GOLD`

## Intentional legacy traits

- Old Maven coordinates and plugin versions
- Java 7 source/target
- `commons-lang:2.6`
- `log4j:1.2.17`
- JUnit 4 tests
- Mutable POJO model
- Raw `Map` usage
- `SimpleDateFormat` in shared state

## Layout

```text
legacy-customer-utils/
  pom.xml
  src/main/java/com/acme/legacy/customer/...
  src/main/resources/region-prefixes.properties
  src/test/java/com/acme/legacy/customer/...
```
