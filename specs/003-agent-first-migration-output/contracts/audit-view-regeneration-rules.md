# Contract: view-regeneration audit rules (`audit.rules.yaml`)

**Audience**: stack-pack authors; the audit engine; reviewers reading findings.
**File**: `stacks/<pack>/audit.rules.yaml` and `package/stacks/<pack>/audit.rules.yaml`.

Rules follow the existing `StackAuditRule` schema (`migration/guildctl/stack.ts`). No engine
change — the engine already applies every rule regex to every registered artifact's content.

## Rule set (java-spring)

```yaml
- id: view-regeneration-jsp
  finding: jvm
  category: view-regeneration
  severity: critical
  match: '<%@|<jsp:|<%[!=]'
  flags: g
  summary_template: 'JSP view artifact detected: {symbol}'
  remediation: Replace with the pack-declared API contract output (see stack.yaml view_contract). Extract routing, validation, and business logic; drop layout, markup, and styling.
  details_template: 'Legacy view-layer UI must not be regenerated in modern/. Evidence: L{line}: {text}'

- id: view-regeneration-jsf
  finding: jvm
  category: view-regeneration
  severity: critical
  match: '\b(?:javax\.faces|jakarta\.faces)\b|<[hf]:[A-Za-z]'
  flags: g
  summary_template: 'JSF/Facelets view artifact detected: {symbol}'
  remediation: Replace with the pack-declared API contract output. Extract behavior; drop the component tree and presentation.
  details_template: 'Legacy view-layer UI must not be regenerated in modern/. Evidence: L{line}: {text}'

- id: view-regeneration-legacy-view-imports
  finding: jvm
  category: view-regeneration
  severity: critical
  match: '\b(?:javax\.servlet\.jsp|JspException|PageContext|TagSupport|org\.apache\.struts\.taglib)\b'
  flags: g
  summary_template: 'Legacy view-framework usage in migrated code: {symbol}'
  remediation: Remove the view-framework dependency; the module must expose an API contract backed by behavior-preserving handlers.
  details_template: 'View-framework imports indicate regenerated view-layer UI. Evidence: L{line}: {text}'

- id: view-regeneration-template-engine
  finding: jvm
  category: view-regeneration
  severity: warning
  match: '\b(?:TemplateEngine|thymeleaf|freemarker|velocity)\b.*(?:process|render)'
  flags: g
  summary_template: 'Server-side template rendering of a possibly legacy-derived view: {symbol}'
  remediation: Confirm this is a target-native, reviewable exception and not regenerated legacy UI; otherwise replace with the API contract output.
  details_template: 'Target-side server rendering is an explicit exception, not a default. Evidence: L{line}: {text}'
```

## Semantics

- **Critical** rules (`jsp`, `jsf`, `legacy-view-imports`) fire on unambiguous legacy-view
  traces — these are prohibited outright and block approval (SC-003).
- **Warning** rule (`template-engine`) fires on *possibly* legitimate target-native rendering;
  it routes to review rather than hard-blocking, preserving the spec's "explicit, reviewable
  exception" path for target-side views.
- Findings use the existing `jvm_audit_findings` path — same shape, same remediation flow as
  every other rule (FR-006). No parallel reporting mechanism.
- Templates use only the closed placeholder vocabulary (`{symbol}`, `{line}`, `{text}`,
  `{version}`, `{target}`); unknown placeholders throw at pack load.

## False-positive guard

Legitimate contract/handler code (Spring MVC controllers, DTO validation) matches none of
these patterns: no `<%@`/`<jsp:`/EL directives, no `javax.faces`, no JSP/Struts taglib
imports, no `TemplateEngine.process` of a legacy template. The clean-tree case (spec Story 2
Scenario 2) produces zero findings; this is asserted by `migration/test/audit-view-regeneration.test.ts`.
