# Contract: Stack-Pack `dependencies:` Block

**Feature**: `006-dependency-disposition` | **Date**: 2026-08-16

Per Principle VII, all stack-specific dependency knowledge lives in stack packs,
never in core runtime code. This contract adds an OPTIONAL `dependencies:` block
to each pack's `classification.yaml` (parsed by a new loader in
`migration/guildctl/dispositions.ts`, reusing the same YAML parsing path as
`loadClassificationSpec` in `migration/guildctl/classification.ts`).

A pack without the block is valid: the collector degrades to a findings-derived
library universe with keep-default proposals (fail-closed toward keep — never
toward silent pruning, spec edge case #2).

## YAML shape

```yaml
# stacks/java-spring/classification.yaml (excerpt — new optional block)
dependencies:
  # Where build manifests live, relative to the workspace root. Used by the
  # collector to discover declared third-party libraries (research.md §3).
  manifest_globs:
    - "**/pom.xml"
    - "**/build.gradle"
    - "**/build.gradle.kts"

  # Map from canonical library coordinate to the source import/package prefixes
  # used for usage analysis (research.md §4). Prefixes are matched against
  # import statements and qualified references in registered source files.
  library_prefixes:
    "org.apache.commons:commons-lang3": ["org.apache.commons.lang3"]
    "com.google.guava:guava": ["com.google.common"]
    "joda-time:joda-time": ["org.joda.time"]

  # Advisory native-equivalent seeds for replace-with-native proposals
  # (research.md §6). `native` names the Java 17/21 platform replacement;
  # `note` is copied into the proposal rationale.
  native_equivalents:
    "joda-time:joda-time":
      native: "java.time"
      note: "java.time supersedes Joda-Time since Java 8; JSR-310 is the platform API."
    "com.google.guava:guava":
      native: "java.util / java.util.Objects / java.util.Optional"
      note: "Only valid when usage is limited to base utilities (Optional, Precondition, Strings); deep Guava usage (collections, cache) must stay keep."
```

## Validation rules (loader)

- Unknown top-level keys inside `dependencies:` → load error naming the pack and
  key (same strictness posture as `classification.yaml`'s spec validation).
- `manifest_globs` entries must be non-empty strings.
- `library_prefixes` values must be non-empty string arrays.
- `native_equivalents.<lib>.native` must be non-empty when the entry exists.
- Every key in `native_equivalents` SHOULD appear in `library_prefixes`; a
  missing prefix entry is a load-time WARNING (not an error) since the proposal
  seed is still useful without usage-prefix mapping.
- The python pack MAY ship an equivalent block later (stdlib equivalents);
  v1 ships java-spring content only. Both `stacks/` and `package/stacks/`
  mirrors MUST receive identical blocks (DEVELOPMENT.md parity requirement).

## Consumption contract

| Consumer | Field(s) used | Failure mode when absent |
|---|---|---|
| Collector — library universe | `manifest_globs` | Findings-derived universe only; `scan_notes` records the limitation (FR-012). |
| Collector — usage analysis | `library_prefixes` | `usage_json` empty for that library; rationale notes "no usage-prefix mapping". |
| Collector — proposal seeding | `native_equivalents` | Default proposal is `keep` (fail-closed). |
| Planner agent | all, via `propose-disposition` refinement | Agent may refine beyond pack knowledge; proposals always flow through confirmation regardless. |

## Non-goals for v1

- No version-range semantics, no remote repository resolution (research.md §9).
- No per-module overrides — disposition grain is per-library per workspace;
  module divergence resolves conservatively to keep (spec assumptions).
