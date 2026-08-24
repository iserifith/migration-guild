# Dependency Dispositions Deep-Dive

## Purpose and Overview

Before an AI agent can plan the migration of a workspace, it needs to know what to do with the legacy system's external libraries. Rather than relying on an LLM to guess which dependencies to keep and which to replace, the Guildctl subsystem uses a deterministic collector: `collectDispositions` (`migration/guildctl/dispositions.ts:47`).

This script runs across the entire workspace to compute the "Library Universe," analyze actual usage within legacy source files, and seed proposed actions (dispositions) into the SQLite registry (`dependency_dispositions` table). The AI planner later relies on these confirmed dispositions to guide its modernization strategy.

The collector is deliberately designed to **fail-closed (default to `keep`)**, ensuring that no dependency is dropped or replaced without explicit operator confirmation or a pre-approved mapping from the active Stack Pack.

---

## 1. Constructing the Library Universe

The collector first determines the complete set of dependencies that exist in the legacy project. It draws from two sources, merging them into a unified map (`LibraryEvidence`) keyed by coordinate (e.g., `group:artifact`).

1. **Dependency Findings (Dynamic/Tooling):**
   It queries the `dependency_findings` table (`dispositions.ts:52-57`), which holds dependencies discovered by language-specific build tools or analyzers. Because a project might declare different versions of the same library across modules, the collector aggregates these by taking the `MAX(current_version)`.

2. **Manifest Extraction (Static/Regex):**
   It uses the active Stack Pack's `manifest_globs` and `dependency_parsers` to manually extract dependencies from build files (e.g., `pom.xml`, `build.gradle`, `requirements.txt`).
   - Files matching `manifest_globs` (or falling back to the pack's default) are found via `findMatchingFiles`.
   - Each file's contents are scanned using regex patterns from `pack.manifest.dependency_parsers` (`dispositions.ts:64-77`).
   - The regex must capture three groups: `group`, `artifact`, and `version`.
   - This provides coverage even if dynamic dependency resolution tools failed to run during the initial audit.

The result is a comprehensive map of `LibraryEvidence` containing all observed versions and a boolean flag `declaredButUnused` initialized to false.

---

## 2. AST-less Usage Analysis

Once the universe is established, the collector determines *where* and *how often* each library is used within the legacy codebase. Because parsing a full AST across multiple languages is prohibitively slow and brittle, the system uses an **AST-less semantic scan** (`dispositions.ts:114-162`).

For every registered `legacy-source` artifact in the registry:
1. **Import Extraction:** It reads the file and grabs `import` statements using a greedy regex (`/^\s*import\s+(?:static\s+)?([\w.]+);?\s*$/`).
2. **Prefix Matching:** It iterates through the universe. If the Stack Pack defines `library_prefixes` for a dependency (e.g., `com.google.common` for Guava), it checks if any of the file's imports start with that prefix.
3. **Qualified Reference Fallback:** If a dependency has *no* prefix mapping in the Stack Pack, the collector falls back to searching for the artifact's name segment (e.g., `DateTime` for `joda-time`) as a whole word (`\b`) directly in the file's text (`dispositions.ts:145`). This catches fully-qualified references that don't have explicit import statements.

If usage is found, the artifact's ID is added to the library's `usageArtifacts` set, and its `importCount` is incremented.

---

## 3. Deterministic Proposal Seeding

With the universe and usage data collected, the script determines the initial disposition for each library and upserts it into the database via `upsertProposedDisposition` (`registry/commands/dispositions.ts`).

### Version Conflict Resolution
If multiple versions of a library were found, the collector resolves the conflict by selecting the **maximum version** (`maxVersion`) using a version-aware comparison function (`compareVersions`, `dispositions.ts:220`). It adds a `conflictNarrative` to the proposal's rationale (FR-008: *"Version conflict across findings/manifests... resolved to MAX"*).

### Seeding Logic
The `disposition` is assigned based on the following precedence (`dispositions.ts:178-200`):

1. **Declared but Unused (Scan Limitation):**
   If a library was found in manifests but has no usage evidence (`usingArtifacts.length === 0`), it is seeded as `"keep"`. The system assumes this is a scan limitation (the AST-less regex missed it, or it's a runtime-only dependency) rather than proof it can be safely dropped.
   *Rationale:* `"Keep proposal seeded by collector: declared in manifests but no usage evidence found (scan-limitation)."`

2. **Replace with Native:**
   If the Stack Pack explicitly maps the library in its `native_equivalents` block (e.g., `joda-time` -> `java.time`), the collector proposes `"replace-with-native"` and locks the `nativeReplacement` field.
   *Rationale:* `"Replace-with-native proposal seeded by collector from pack native_equivalents: {native}."`

3. **Keep (Default):**
   If usage is confirmed but no native equivalent is known, the collector defaults to `"keep"`.
   *Rationale:* `"Keep proposal seeded by collector: used by legacy artifacts and no native equivalent is declared in the stack pack."`

All proposals are assigned `proposedBy = "planner-collector"`.

---

## 4. Invariants and Constraints

- **Fail-Closed on Unknowns:** The collector *never* invents a removal or replacement disposition on its own. If it doesn't have an explicit `native_equivalent` from the Stack Pack, it defaults to `keep`.
- **Usage Limits:** To avoid bloating the SQLite database, the `using_artifacts` list persisted in `usageJson` is strictly capped at `MAX_USING_ARTIFACTS` (20), though the total `using_artifact_count` remains accurate.
- **Operator Supremacy:** The non-keep decision *always* belongs to the operator or the Stack Pack. The collector only *proposes* these dispositions (status = `proposed`). They must be manually confirmed or overridden by an operator (`guildctl confirm-dispositions`) before the pipeline readiness gate will allow planning to proceed.

---

## 5. Extension Points

- **New Dependency Parsers:** To support non-Java ecosystems (e.g., Python `requirements.txt`, Node `package.json`), you add a new parser to the Stack Pack manifest with a regex that captures `group:artifact:version`. The collector will automatically apply it.
- **New Native Equivalents:** Modifying the `native_equivalents` block in the Stack Pack's disposition spec automatically changes the collector's proposed seeded state from `keep` to `replace-with-native` for future scans.
