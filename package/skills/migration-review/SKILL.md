---
name: migration-review
description: "Review migrated code and tests for regressions, remaining legacy constructs, architecture problems, and missing tests. Use after a migration step and before human approval."
argument-hint: "Path to a migrated file or target module area to review"
---

# Migration Review

Use this skill after a migration step to review the target-side code with a strict code-review mindset.

## When to Use

- A migrated file and its tests have been written.
- You want to catch behavior drift before human review.
- You need a consistent checklist for migration quality.

## Review Procedure

1. Read the migrated file.
2. Read associated tests.
3. Compare the migrated behavior to the legacy source when available.
4. Check for:
   - remaining source-framework imports or annotations
   - incorrect target framework annotations or layering
   - hardcoded config values that should be externalized
   - weak or missing tests
   - obvious behavior regressions
   - awkward package placement or architecture drift
5. Apply the structural checklist below.
6. Return findings ordered by severity.

## Structural Checklist

Run these checks against every migrated file before closing a review.

### Test fixture placement
- No test-only class (`*TestUtil`, `*TestTransform`, `*FakeTransform`, `*ExplodingTransform`, `testdomain/**`, `*GuiceTransform`, `*BadSpec`, `*GoodTest`) should appear under `src/main/java`.
- If found: **Critical** — move to `src/test/java`.

### Stub test files
- Every `*Test.java` under `src/test/java` must contain at least one `@Test` or `@ParameterizedTest` method.
- Files with zero test annotations are **Warning** stubs and must be implemented or removed.

### Dead code
- A class in `src/main/java` with zero references across the entire `modern/` tree (excluding its own declaration) is **Critical** dead code.
- Check with: `grep -r "\b<ClassName>\b" modern/src --include="*.java" | grep -v "class <ClassName>"`

### Build dependency scope
- Any library imported **only** in `src/test/java` must be `testImplementation` (Gradle) or `<scope>test</scope>` (Maven), not `implementation`/`compile`.
- Common culprits: `guava`, `assertj`, `mockito`, `hamcrest`, `jsonassert`.

### Defensive copies on mutable input
- Methods that accept `Map`, `List`, or any mutable collection and mutate it without a defensive copy are **Critical** correctness bugs.
- Look for `// TODO: Make copy` or direct mutation of a parameter.

### View modules — must be API contracts, never regenerated UI
Legacy view-handling modules (JSP pages, JSF/Facelets views, Struts forms, servlet page
renderers) migrate to **structured API contracts** (OpenAPI / MCP tool schemas) — never to
regenerated view-layer UI. The stack pack's `view_contract` block and the `view-regeneration-*`
audit rules enforce this. For every migrated file that originated from a view-handling legacy
module, verify the following. Any failure is **Critical**.

- **No view-layer artifacts in `modern/`.** Reject any `.jsp`, `.jspx`, or `.xhtml` file
  under `modern/`, JSP scriptlet/directive/taglib syntax (`<%@|<jsp:|<%[!=]`) in any Java
  source, JSF/Facelets imports (`javax.faces` / `jakarta.faces`) or tag usage (`<h:` / `<f:`),
  and any legacy view-framework import (`javax.servlet.jsp`, `JspException`, `PageContext`,
  `TagSupport`, `org.apache.struts.taglib`).
- **Routing, validation, and business logic preserved as behavior.** The migrated module
  exposes its surface as the pack-declared contract (`view_contract.format`, default
  `openapi`, with `alternates: [mcp-tools]` permitted). Endpoints and handlers cover the
  legacy view's behavior end-to-end — discarding layout must never mean discarding logic.
- **Layout, markup, and styling dropped, not ported.** Template structure, CSS, JavaScript
  includes, custom-tag usage, and presentation helpers must not appear in `modern/`.
- **Purely-presentational views recorded as skipped.** A view with no scriptlet/EL logic
  and no bound backing bean — only layout — must be `status: skipped` with the
  `view-dropped-presentational` tag plus an artifact event carrying the stated reason.
  Reject any attempt to regenerate it as UI.
- **Low-confidence presentation/behavior separation fails closed to review.** If the agent
  cannot confidently separate behavior from presentation, the artifact must be marked
  `blocked` with the `blocked-human-decision` tag rather than regenerated as UI.
- **Server-side template rendering (thymeleaf/freemarker/velocity) is a Warning** unless
  the target is explicitly template-native and reviewable. Confirm intent before approving.

Quick scan commands to copy into the review notes:
```bash
find modern -type f \( -name "*.jsp" -o -name "*.jspx" -o -name "*.xhtml" \) 2>/dev/null
grep -rEn '<%@|<jsp:|<%[!=]|\b(javax\.faces|jakarta\.faces|javax\.servlet\.jsp|JspException|PageContext|TagSupport|org\.apache\.struts\.taglib)\b' \
  modern/src --include="*.java"
grep -rEn '<[hf]:[A-Za-z]' modern --include="*.xhtml"
grep -rEn '\b(TemplateEngine|thymeleaf|freemarker|velocity)\b.*(process|render)' \
  modern/src --include="*.java"
```

### View-logic placement — extracted logic must land in dedicated modules
Amends the section above (issue #100): even when a view-handling module correctly lands as a
contract-backed endpoint, its extracted validation/business logic must consolidate into
**dedicated, named modules** — never inline in the handler, never duplicated per-endpoint. The
stack pack's `logic_extraction` block and the `view-logic-placement-*` audit rules enforce this.
For every migrated view-handling module, verify the following. Any failure is **Critical** (a
finding, not an approval) — the audit rule itself fires at Warning severity precisely so this
checklist item, not the automated scan, makes the final call.

- **Validation lands in a dedicated `*Validator`; business logic in a dedicated `*Service`.**
  (Suffixes come from the pack's `logic_extraction.validator_suffix` / `.service_suffix`.)
- **The handler only binds and delegates.** Routing, parameter binding, invoking the
  service/validator, response shaping — no non-trivial validation or business-rule logic
  inline in the contract-backed endpoint/handler itself.
- **No rule duplicated across endpoints.** A rule shared by multiple endpoints lives in one
  shared module used by all of them, never copied per-handler.
- **Trivial pass-through views are exempt.** A view with no real validation/business rules
  beyond delegation needs no empty `*Service`/`*Validator` shell.

Quick scan commands:
```bash
grep -rEn '\b(Controller|Resource|Endpoint)\b' modern/src --include="*.java" -l | while read -r f; do
  grep -Hn -E '\.(isEmpty|hasErrors)\(\)|== *null|\.matches\("' "$f" | grep -v -E '\b(Validator|Service)\b'
  grep -Hn -E '\}\s*else\s+if\s*\(' "$f" | grep -v -E '\b(Validator|Service)\b'
done
grep -rEn '\.(isEmpty|hasErrors)\(\)|== *null|\.matches\("' modern/src --include="*.java" \
  | sed -E 's/^[^:]+:[0-9]+://' | sort | uniq -c | sort -rn | awk '$1 >= 2'
```

## Output Rules

- Findings come first.
- Prioritize correctness bugs, misplaced fixtures, and regressions over style.
- If there are no findings, state that explicitly and mention remaining risks or test gaps.
