# Phase 1 Data Model: Agent-First Migration Output

This feature adds no new database tables and changes no registry schema. Its "entities" are
the pack-level declarations and artifact-state conventions the rules operate on. All storage
reuses existing tables: `artifacts` (status/tags/events), `jvm_audit_findings`,
`dependency_findings`.

## Entities

### View-handling module (legacy artifact)

- **Identity**: a `legacy-source` artifact whose path matches a view-technology glob
  (`**/*.jsp`, `**/*.jspx`, `**/*.xhtml`) or whose content matches a view-framework
  classification signal.
- **Registry fields used**: existing `artifacts` columns — `id`, `kind: "legacy-source"`,
  `path`, `module`, `status`, plus framework/role recorded through the existing
  classification evidence path (no new column; classification results are already stored
  against the artifact).
- **Classification** (java-spring `classification.yaml` additions):
  - frameworks added to `frameworks.allowed`: `jsp`, `jsf` (with aliases such as
    `jspx: jsp`, `facelets: jsf`).
  - signals (priority-ordered so view technologies classify distinctly from plain servlet):
    - `jsp-view`: content matches `<%@`, `<jsp:`, or `.jsp` extension → framework `jsp`,
      role `rest-endpoint`, confidence ~0.9 (the artifact's *handler* migrates to an endpoint).
    - `jsf-view`: content matches `javax.faces`/`jakarta.faces`/`<h:`/`<f:` → framework
      `jsf`, role `rest-endpoint`, confidence ~0.9.
  - Purely-presentational views (no scriptlet/EL logic, no bound backing bean): fall through
    to the pack's existing fallback/ambiguity path — classified with explicit negative
    evidence rather than absorbed silently (constitution VII).

### API contract output (target artifact)

- **Identity**: the `target-source` artifact produced from a migrated view-handling module —
  a contract definition (per the pack's `view_contract` declaration; OpenAPI-style REST for
  java-spring) plus the behavior-preserving endpoint/handler code backing it.
- **Registry fields used**: existing `target-source` artifact + `source-of` relation linking
  it to the legacy view artifact. No new kind or column.
- **Content invariants** (enforced by audit + review, not schema):
  - carries the legacy module's routing, parameter binding, validation, business logic;
  - carries **no** legacy layout/markup/styling/template structure;
  - declares itself in the pack's contract format (`view_contract.format`).

### View-regeneration finding (audit finding)

- **Identity**: a row in the existing `jvm_audit_findings` table produced by the new
  `view-regeneration-*` audit rules, or a registry remediation artifact created by the
  post-migration audit prompt/agent for a `modern/`-tree hit.
- **Fields** (existing schema): `category: "view-regeneration"`,
  `severity: "critical" | "warning"`, `symbol`, `summary`, `evidence` (`L{line}: {text}`),
  `remediation` — interpolated from the rule's templates via the closed placeholder
  vocabulary.
- **Lifecycle**: identical to every other audit finding (FR-006) — created/replaced by
  `replaceJvmAuditFindings`, surfaced in audit summaries, queued for remediation via
  `create-artifact`.

### Intentional-drop record

- **Identity**: a legacy view artifact whose migration outcome is "deliberately not migrated"
  because it was purely presentational.
- **Representation**: `artifacts.status = "skipped"` + a meaningful tag (e.g.
  `view-dropped-presentational`, added to `tags.meaningful` in `classification.yaml`) + an
  artifact event carrying the stated reason. All existing mechanisms; no schema change.
- **Invariant**: a dropped view artifact is *visible* in migration state (listable by
  status/tag) — never silently absent (FR-004, spec Story 1 Scenario 3).

## Relationships

```text
legacy view-handling module (legacy-source)
  │  source-of
  ▼
API contract output (target-source)          ── when migrated
  │
  ▼ audited by
view-regeneration finding (jvm_audit_findings) ── only if the rule is violated

legacy view-handling module (legacy-source)
  │  status=skipped + tag + event(reason)
  ▼
intentional-drop record                       ── when purely presentational
```

## Validation rules

- A `modern/` tree MUST yield zero `critical` `view-regeneration` findings (SC-001/SC-003).
- Every registered legacy view artifact MUST reach exactly one of: migrated to contract
  output, or intentional-drop record. No third terminal state (SC-001).
- Rule templates MUST use only `{symbol, line, text, version, target}` (pack-load validation
  already throws on unknown placeholders).

## State transitions

View artifacts follow the existing artifact status lifecycle
(`pending → planned → analyzed → … → migrated → reviewed → completed`), with `skipped` as the
terminal state for intentional drops and `blocked` (+ `blocked-human-decision`) for
fail-closed low-confidence separations. No new statuses.
