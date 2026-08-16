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

## 8. View-Regeneration Artifacts (no UI from legacy views)

Legacy view-handling modules (JSP pages, JSF/Facelets views, Struts forms, servlet page renderers)
must migrate to **structured API contracts** (OpenAPI / MCP tool schemas) — never to regenerated
view-layer UI. The `view_contract` block in the stack pack and the `view-regeneration-*`
audit rules enforce this. Scan for any of the following markers in `modern/`; every hit is
**Critical**.

### 8a. JSP / JSPX / XHTML presence
```bash
find modern -type f \( -name "*.jsp" -o -name "*.jspx" -o -name "*.xhtml" \) 2>/dev/null
find modern -type f \( -name "*.jsp" -o -name "*.jspx" -o -name "*.xhtml" \) 2>/dev/null | wc -l
```
Any non-zero count is **Critical**: layout/markup/styling must be dropped, not ported.

### 8b. JSP scriptlet / directive / taglib syntax inside Java sources
```bash
grep -rEn '<%@|<jsp:|<%[!=]' modern/src --include="*.java"
grep -rEn '<%@|<jsp:|<%[!=]' modern --include="*.jsp" --include="*.jspx" --include="*.xhtml"
```

### 8c. JSF / Facelets imports and tags
```bash
grep -rEn '\b(javax\.faces|jakarta\.faces)\b' modern/src --include="*.java"
grep -rEn '<[hf]:[A-Za-z]' modern --include="*.xhtml"
```

### 8d. Legacy view-framework imports
```bash
grep -rEn '\b(javax\.servlet\.jsp|JspException|PageContext|TagSupport|org\.apache\.struts\.taglib)\b' \
  modern/src --include="*.java"
```

### 8e. Server-side template rendering (warning)
```bash
grep -rEn '\b(TemplateEngine|thymeleaf|freemarker|velocity)\b.*(process|render)' \
  modern/src --include="*.java"
```
Hits are **Warning** unless the target is explicitly template-native and reviewable; otherwise
treat as **Critical**.

### Resolution

For every **Critical** hit under 8a–8d:
- The artifact must be reclassified to expose the pack-declared API contract
  (`view_contract.format`, default `openapi`, with `alternates: [mcp-tools]` permitted).
- Routing, validation, and business logic preserved as behavior; layout/markup/styling dropped.
- Purely-presentational views are recorded with `status: skipped` plus the
  `view-dropped-presentational` tag and an artifact event carrying the reason.
- Low-confidence presentation/behavior separation fails closed to review (`blocked` with the
  `blocked-human-decision` tag) rather than regenerating UI.

## 9. View-Logic Placement (dedicated Service/Validator modules)

Amends #59 (Section 8): even when a view-handling module correctly lands as a contract-backed
endpoint rather than regenerated UI, its extracted validation/business logic must consolidate
into **dedicated, named modules** — never inline in the handler, never duplicated per-endpoint.
The `logic_extraction` block in the stack pack and the `view-logic-placement-*` audit rules
enforce this. Scan the `modern/` tree holistically (not just per-artifact) for both signals below;
every hit is **Warning** (the tool cannot always tell "non-trivial" from a legitimate short
guard clause — record the finding and let the reviewer resolve borderline cases).

### 9a. Inline validation/business-rule logic in handler-named classes
```bash
grep -rEn '\b(Controller|Resource|Endpoint)\b' modern/src --include="*.java" -l | while read -r f; do
  grep -Hn -E '\.(isEmpty|hasErrors)\(\)|== *null|\.matches\("' "$f" | grep -v -E '\b(Validator|Service)\b'
  grep -Hn -E '\}\s*else\s+if\s*\(' "$f" | grep -v -E '\b(Validator|Service)\b'
done
```
A hit means a handler-named class (`*Controller`/`*Resource`/`*Endpoint`) contains an inline
validation guard, `BindingResult` check, pattern-match guard, or multi-branch business decision
with no `*Service`/`*Validator` collaborator reference on that line.

### 9b. Per-endpoint duplication
```bash
# Look for the same validation/business predicate repeated across 2+ handler files —
# a signal the rule should have been extracted into ONE shared module, not copied.
grep -rEn '\.(isEmpty|hasErrors)\(\)|== *null|\.matches\("' modern/src --include="*.java" \
  | sed -E 's/^[^:]+:[0-9]+://' | sort | uniq -c | sort -rn | awk '$1 >= 2'
```
Any predicate appearing 2+ times across different handler files is a deduplication finding,
even if each individual occurrence would otherwise be a legitimate extraction candidate.

### Resolution

For every 9a/9b hit:
- Extract validation logic into a dedicated, named `*Validator` module (suffix from the pack's
  `logic_extraction.validator_suffix`); business logic into a dedicated, named `*Service` module
  (`logic_extraction.service_suffix`).
- The handler is left binding and delegating only — routing, parameter binding, invoking the
  service/validator, response shaping.
- A rule shared across multiple endpoints (9b) consolidates into ONE module used by all of them.
- A trivial pass-through view with no real validation/business rules needs no empty
  `*Service`/`*Validator` shell.

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

### 8. View-Regeneration Artifacts
[list each hit with file, line, marker category (JSP/JSPX/XHTML file, JSP syntax, JSF, view import, template render), and severity (Critical by default, Warning for 8e unless template-native); ✅ clean if no hits]

### 9. View-Logic Placement
[list each hit with file, line, signal (inline validation/BindingResult/pattern-guard, multi-branch business rule, or per-endpoint duplication), and Warning severity; ✅ clean if no hits]

### Prioritized Fix List
| # | Action | Files | Severity |
|---|---|---|---|
```

Prioritize by: correctness bugs > misplaced fixtures > broken imports > legacy imports > dead code > missing tests > build hygiene.

**View-regeneration findings outrank cosmetic audit findings.** Any Critical hit in section 8 must be remediated before the migration is considered view-clean.

## Create Registry Entries for Remediation

For each finding in the prioritized list, create a registry entry so it can be queued in the next migration wave:

### For each misplaced test fixture (Critical)
```bash
node migration/dist/registry/cli.js create-artifact \
  --path "modern/src/main/java/com/bazaarvoice/jolt/chainr/transforms/JoltTestUtil.java" \
  --artifact-type "fix-misplaced-fixture" \
  --category "code-quality" \
  --tier second-class \
  --status planned
```
Repeat for each file found in Step 6a.

### For correctness bugs (Critical)
```bash
node migration/dist/registry/cli.js create-artifact \
  --path "modern/src/main/java/com/bazaarvoice/jolt/Defaultr.java" \
  --artifact-type "fix-mutation-bug" \
  --category "correctness" \
  --tier second-class \
  --status planned
```

### For dead code (Critical)
```bash
node migration/dist/registry/cli.js create-artifact \
  --path "modern/src/main/java/com/bazaarvoice/jolt/TestInstanceOfVSEnumSwitch.java" \
  --artifact-type "delete-dead-code" \
  --category "cleanup" \
  --tier second-class \
  --status planned
```

### For build scope issues (Warning)
```bash
node migration/dist/registry/cli.js create-artifact \
  --path "modern/build.gradle" \
  --artifact-type "fix-build-scope" \
  --category "build" \
  --tier second-class \
  --status planned
```

### For view-regeneration findings (Critical; per hit)
```bash
node migration/dist/registry/cli.js create-artifact \
  --path "<modern/path/to/ViewArtifact.java|.jsp|.xhtml>" \
  --artifact-type "replace-view-with-api-contract" \
  --category "view-regeneration" \
  --tier first-class \
  --status planned
```
For purely-presentational views with no behavior, mark `skipped` instead and append an event:
```bash
node migration/dist/registry/cli.js set-artifact-status --id "<id>" --status skipped \
  && node migration/dist/registry/cli.js append-event \
       --id "<id>" --type reviewed --agent audit-agent \
       --summary "view-dropped-presentational: layout-only JSP/JSF/Struts view, no scriptlet/EL/backing-bean behavior to extract"
```

### For view-logic-placement findings (Warning; per hit)
```bash
node migration/dist/registry/cli.js create-artifact \
  --path "<modern/path/to/HandlerArtifact.java>" \
  --artifact-type "extract-view-logic-to-module" \
  --category "view-logic-placement" \
  --tier second-class \
  --status planned
```

### For critical missing tests
```bash
node migration/dist/registry/cli.js create-artifact \
  --path "modern/src/test/java/com/bazaarvoice/jolt/ShiftrTest.java" \
  --artifact-type "add-test" \
  --category "test-coverage" \
  --tier second-class \
  --status planned
```

### List ready and migrate
```bash
node migration/dist/registry/cli.js list-ready
# All new audit entries now appear ready to claim

# Start migration via Migration Guild:
guildctl migrate
```
