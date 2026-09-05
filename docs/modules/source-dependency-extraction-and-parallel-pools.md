# Source-Level Dependency Extraction and Parallel Pooling

## Purpose and Overview

The source-level dependency graph forms the backbone of `migration-guild`'s structured modernization approach. Unlike many legacy modernization tools that rely strictly on package managers or compiled byte-code (which might be unavailable for broken legacy projects), `migration-guild` deterministically parses the raw syntax (e.g., `import`, `extends` in Java, or `import` in Python) in `migration/registry/commands/sourceDeps.ts`.

By mapping exact textual imports to registered components, the pipeline creates a directed acyclic graph (DAG) of the codebase. This graph powers the **Planner** stage (`migration/guildctl/commands/plan.ts`) to group artifacts into **Parallel Pools** (or waves). Ensuring that a low-level utility is modernized before the high-level business logic that depends on it prevents downstream modernization agents from hallucinating dependencies.

## Architecture

The dependency extraction and parallel pooling logic is fully deterministic (no LLMs are used) and resides mainly in `migration/registry/commands/sourceDeps.ts`.

It runs in two major phases:
1. **Extraction (Inventory Phase)**: During `guildctl run inventory`, raw file contents are regex-scanned to find imports, which are mapped to registered `artifact_id`s.
2. **Pooling (Planner Phase)**: During `guildctl run plan`, the dependency graph is traversed. Cycles are collapsed into Strongly Connected Components (SCC), and a topological level-order traversal assigns artifacts into execution waves.

### Step 1: Extraction & Name Resolution
Inside `migration/registry/commands/sourceDeps.ts:extractSourceDependencies`, the system processes file content line-by-line using regular expressions:

```typescript
  if (lang === "java") {
    for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
      push(resolveJavaFqcn(m[1], ids, aliases), "import");
    }
```

When an import is found (e.g., `com.example.Utils`), it must be resolved against the set of known, registered artifacts. This is done via `migration/registry/commands/sourceDeps.ts:resolveQualifiedName`.
- The resolver attempts exact matches, suffix matches (e.g., `legacy-source:com.example:Utils`), and alias resolutions.
- If a name is ambiguous (multiple artifacts match the suffix), it safely returns `null`, preferring missing edges over incorrect ones. The strategy is explicitly fail-safe: missing a dependency might reduce optimal ordering, but hallucinating a dependency could create unbreakable cycles.

### Step 2: Cycle Detection & Tarjan's SCC
Real-world legacy codebases frequently contain circular dependencies (e.g., `A` imports `B`, and `B` imports `A`). A naive topological sort over a cyclic graph will infinite-loop or fail.

To resolve this, the system implements **Tarjan's Strongly Connected Components algorithm** in `migration/registry/commands/sourceDeps.ts:collapseSCC`.
- Nodes (artifacts) and edges (dependencies) are fed into Tarjan's algorithm.
- Any cyclic group of artifacts is collapsed into a single component (an SCC).
- The resulting graph of components is guaranteed to be a Directed Acyclic Graph (DAG).

```typescript
// Strongly-connected components (Tarjan) — collapses cycles so cycle members are
// serialized together for pool safety.
export function collapseSCC(nodes: string[], edges: Array<[string, string]>): string[][] {
```

### Step 3: Topological Pooling
Once the graph is acyclic, `migration/registry/commands/sourceDeps.ts:buildParallelPools` assigns components into "levels" (waves).
- The algorithm calculates the longest path to each component.
- Nodes at level `L` only depend on nodes at levels `< L`.
- Singleton components at the same level can be safely migrated in parallel.
- Components that contain cycles (multiple artifacts in one SCC) must be executed serially relative to each other within their assigned level, as their exact inter-dependency cannot be decoupled.

## Invariants and Edge Cases

- **No Self-Dependencies**: `extractSourceDependencies` explicitly ignores an import if it resolves to the `dependentId` itself.
- **Fail-Safe Ambiguity**: `resolveQualifiedName` will return `null` if multiple components match an unqualified import, treating the dependency as unresolvable rather than risking a false edge.
- **Cycle Safety**: An SCC containing multiple artifacts will map each artifact to its own singleton pool at that level. The runner then drains pools serially, ensuring the cycle members are not attempted simultaneously in a way that violates state assumptions.

## Gotchas

- **AST vs Regex**: The extraction relies entirely on Regex, not AST parsers. This is intentional: legacy code might not compile, and AST parsers would fail. Regex gracefully degrades but might capture commented-out imports. This is an accepted trade-off (false positives just result in tighter pooling).
- **Manual Overrides**: Operators can inject edges via `migration/registry/commands/sourceDeps.ts:addManualDependency`. These edges persist with `created_by = 'manual'` and are immune to auto-extraction clears (`DELETE ... WHERE created_by = 'auto'`).

## Extension Points

- **New Languages**: Adding a new language (e.g., `C#` or `TypeScript`) simply requires expanding the `SourceLang` union and adding new Regex capture logic in `migration/registry/commands/sourceDeps.ts:extractSourceDependencies`. The Tarjan and Pooling logic is entirely language-agnostic.
