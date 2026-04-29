---
description: "Run a holistic post-migration quality audit on the modern/ output tree. Produces a structured findings report with registry entry creation commands to queue all findings for remediation."
---

Run a holistic post-migration audit of `modern/` and produce a structured findings report. Generate registry entry commands for all actionable findings.

## Inventory

Count production and test files:
```bash
find modern/src/main/java -name "*.java" | wc -l
find modern/src/test/java -name "*.java" | wc -l
```

## 1. Test Coverage Gaps

Identify production classes with no corresponding `*Test.java`:
```bash
find modern/src/main/java -name "*.java" | xargs -I{} basename {} .java | sort > /tmp/prod_classes.txt
find modern/src/test/java -name "*.java" | xargs -I{} basename {} .java | sort > /tmp/test_classes.txt
comm -23 /tmp/prod_classes.txt <(sed 's/Test$//' /tmp/test_classes.txt | sort)
```

Classify each untested class as **Critical** (core domain / service / controller / utility) or **Warning** (support / config / inner).

## 2. Stub Test Files

Find test files with zero `@Test` or `@ParameterizedTest` annotations:
```bash
for f in $(find modern/src/test/java -name "*.java"); do
  cnt=$(grep -c "@Test\|@ParameterizedTest" "$f" 2>/dev/null || echo 0)
  [ "$cnt" -eq 0 ] && echo "STUB $f"
done
```

## 3. Broken Imports

Find imports in modern/src/main/java that cannot map to declared build dependencies:
```bash
grep -rn "^import " modern/src/main/java --include="*.java" \
  | grep -v "import java\.\|import javax\.\|import org\.junit\|import org\.mockito" \
  | sort -u
```
Cross-reference against `build.gradle` or `pom.xml` declared dependencies.

## 4. Legacy Framework Imports

Scan for source-framework imports that should not appear in modern/:
```bash
grep -rn \
  "^import javax\.ws\.rs\|^import javax\.ejb\|^import javax\.servlet\|^import org\.apache\.struts\|^import org\.springframework\.web\|^import com\.sun\.jersey\|^import org\.jboss" \
  modern/src/main/java modern/src/test/java --include="*.java"
```
Any match is **Critical**.

## 5. Unimplemented Methods and TODOs

```bash
grep -rn "TODO\|FIXME\|HACK\|throw new UnsupportedOperationException" \
  modern/src/main/java --include="*.java"
```

Triage each hit:
- **Critical**: `UnsupportedOperationException` in a public method that a caller can reach at runtime
- **Critical**: `TODO` that marks a correctness or mutation bug (e.g., missing defensive copy)
- **Warning**: `UnsupportedOperationException` used as an intentional type-dispatch guard in a private or `Optional`-covered branch
- **Warning**: `TODO` for design debt with no correctness impact

## 6. Dead Code and Misplaced Fixtures

### 6a. Misplaced test fixtures in src/main/java
Check for test support classes that belong in `src/test/java`:
```bash
grep -rn "TestTransform\|TestUtil\|TestResult\|FakeTransform\|MockTransform\|ExplodingTransform\|BadSpec\|GoodTest\|testdomain\|GuiceTransform\|GuiceMissing" \
  modern/src/main/java --include="*.java" -l
```
Each hit is **Critical** — test-only classes pollute the production artifact.

### 6b. Classes with zero references
For candidate dead classes, check reference count across the full modern/ tree:
```bash
for cls in <candidate class names>; do
  main_refs=$(grep -r "\b${cls}\b" modern/src/main/java --include="*.java" | grep -v "class ${cls}" | wc -l)
  test_refs=$(grep -r "\b${cls}\b" modern/src/test/java --include="*.java" | wc -l)
  echo "$cls -> main: $main_refs, test: $test_refs"
done
```

## 7. Build Dependency Scope

Review `build.gradle` or `pom.xml`:
- Libraries that are only used in `src/test/java` must be declared `testImplementation` (Gradle) or `<scope>test</scope>` (Maven), not `implementation`/`compile`.
- Common culprits: `guava`, `assertj`, `mockito`, `hamcrest`, `jsonassert`.

```bash
cat modern/build.gradle 2>/dev/null || cat modern/pom.xml
```

## Output Format

```markdown
## Post-Migration Audit: <project>

### Inventory
| | Count |
|---|---|
| Production files | N |
| Test files | N |

### 1. Test Coverage Gaps
[list by severity]

### 2. Stub Test Files
[list]

### 3. Broken Imports
[list or ✅ none]

### 4. Legacy Imports
[list or ✅ none]

### 5. Unimplemented Methods / TODOs
[table: file, line, issue, severity]

### 6. Dead Code / Misplaced Fixtures
[list by category]

### 7. Build Scope Issues
[list or ✅ clean]

### Prioritized Fix List
| # | Action | Files | Severity |
|---|---|---|---|
```

Prioritize by: correctness bugs > misplaced fixtures > broken imports > legacy imports > dead code > missing tests > build hygiene.

## Create Registry Entries for Remediation

For each finding in the prioritized list, create a registry entry so it can be queued in the next migration wave:

### For each misplaced test fixture (Critical)
```bash
node migration/registry/dist/cli.js create-artifact \
  --path "modern/src/main/java/com/bazaarvoice/jolt/chainr/transforms/JoltTestUtil.java" \
  --artifact-type "fix-misplaced-fixture" \
  --category "code-quality" \
  --tier second-class \
  --status planned
```
Repeat for each file found in Step 6a.

### For correctness bugs (Critical)
```bash
node migration/registry/dist/cli.js create-artifact \
  --path "modern/src/main/java/com/bazaarvoice/jolt/Defaultr.java" \
  --artifact-type "fix-mutation-bug" \
  --category "correctness" \
  --tier second-class \
  --status planned
```

### For dead code (Critical)
```bash
node migration/registry/dist/cli.js create-artifact \
  --path "modern/src/main/java/com/bazaarvoice/jolt/TestInstanceOfVSEnumSwitch.java" \
  --artifact-type "delete-dead-code" \
  --category "cleanup" \
  --tier second-class \
  --status planned
```

### For build scope issues (Warning)
```bash
node migration/registry/dist/cli.js create-artifact \
  --path "modern/build.gradle" \
  --artifact-type "fix-build-scope" \
  --category "build" \
  --tier second-class \
  --status planned
```

### For critical missing tests
```bash
node migration/registry/dist/cli.js create-artifact \
  --path "modern/src/test/java/com/bazaarvoice/jolt/ShiftrTest.java" \
  --artifact-type "add-test" \
  --category "test-coverage" \
  --tier second-class \
  --status planned
```

### List ready and migrate
```bash
node migration/registry/dist/cli.js list-ready
# All new audit entries now appear ready to claim

# Start migration:
legmod-agent migration-agent
```
