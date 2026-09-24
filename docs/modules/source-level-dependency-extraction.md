# Source-Level Dependency Extraction and Graph Pooling

## Purpose and Overview

The migration-guild orchestrator relies on understanding the relationships between legacy artifacts to safely sequence the migration. This process occurs primarily in `migration/registry/commands/sourceDeps.ts`.

Unlike modern build systems that rely on strict Abstract Syntax Trees (ASTs) or compiler outputs, the inventory phase must analyze uncompilable, broken, or malformed legacy code. To solve this, `sourceDeps.ts` implements a deterministic, regex-based extraction mechanism. It extracts signals (imports and inheritances), resolves them to registered artifacts, and constructs a directed dependency graph.

Crucially, legacy codebases often contain cyclic dependencies (mutual imports). To safely parallelize migration work downstream, the system implements Tarjan's Strongly Connected Components (SCC) algorithm to collapse these cycles, ensuring cycle members are processed serially while still maximizing safe parallel execution across the rest of the graph via topological leveling.

## Architecture and Data Flow

The lifecycle of dependency extraction and pooling consists of three main phases:

### 1. Regex-Based Extraction (`extractSourceDependencies`)

During the inventory phase (`migration/guildctl/commands/inventory.ts:225`), the raw text of each source file is parsed to extract dependency links.

- **Mechanism**: The `extractSourceDependencies` function (`migration/registry/commands/sourceDeps.ts:63`) uses Language-specific regexes.
  - For Java, it matches `import` statements and class/interface inheritance (`extends` or `implements`).
  - For Python, it matches `from X import Y` and `import X`.
- **Resolution**: Extracted raw strings (like `com.acme.Subscription`) are passed to `resolveQualifiedName` (`migration/registry/commands/sourceDeps.ts:16`). This function checks if the fully qualified name (or its simple suffix) matches any known artifact ID or registered alias in the database.
- **Fail-Safe Design**: Because it uses regex, it may capture commented-out imports or string literals. This is an intentional design choice: the pipeline accepts *extra* (false positive) links over missing links. Extra links only reduce parallelism slightly, whereas a missed link could cause a severe sequencing failure where an artifact is migrated before its dependencies.

```typescript
// excerpt from migration/registry/commands/sourceDeps.ts
  if (lang === "java") {
    for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
      push(resolveJavaFqcn(m[1], ids, aliases), "import");
    }
```

The resulting links are persisted via `recordAutoDependencies` (`migration/registry/commands/sourceDeps.ts:104`).

### 2. Cycle Detection and Collapse (`collapseSCC`)

Once all edges are stored in the `source_dependencies` table, the system must prepare them for the execution runner. However, a naive topological sort will fail if the graph contains cycles (e.g., File A imports File B, and File B imports File A).

- **Implementation**: `collapseSCC` (`migration/registry/commands/sourceDeps.ts:154`) implements Tarjan's Strongly Connected Components algorithm.
- **Purpose**: It walks the graph and identifies groups of nodes that form cycles. It returns a `string[][]` where each inner array is a strongly connected component.
- **Serialization**: For nodes within the same component, they cannot be run in parallel because they depend on each other. They must be grouped into the same execution unit or processed serially.

### 3. Topological Pool Assignment (`buildParallelPools`)

The final step is converting the condensed Directed Acyclic Graph (DAG) into execution waves, handled by `buildParallelPools` (`migration/registry/commands/sourceDeps.ts:192`).

- **Graph Condensation**: It uses `collapseSCC` to get the components. A new dependency mapping (`compDeps`) is created between these condensed components rather than individual files.
- **Longest-Path Layering**: It calculates the topological level for each component using a recursive `visit()` function that finds the longest path from the root.
  - Components with no dependencies are Level 0.
  - A component's level is `Max(dependencies' levels) + 1`.
- **Pool Emission**: The function iterates through the levels from `0` to `maxLevel`.
  - Same-level components do not depend on each other and can share a parallel pool.
  - If a component has multiple members (a cycle), those members are emitted as individual singleton pools (e.g., `[[member1], [member2]]`) to guarantee they are processed serially by the runner.
  - Independent singleton components at the same level are grouped into arrays up to the `--parallel` limit.

## Invariants & Edge Cases

- **Manual Dependencies Override**: While `recordAutoDependencies` clears and rewrites `auto` links, it strictly preserves any links marked as `manual` (`migration/registry/commands/sourceDeps.ts:107`), allowing operators to patch the graph if the regex misses a crucial, non-standard dependency.
- **Dangling/Ambiguous Resolution**: If an extracted simple name (like `Utils`) matches multiple registered artifacts and no fully-qualified match is found, `resolveQualifiedName` returns `null` (`sourceDeps.ts:31`). Ambiguous links are dropped to prevent creating incorrect blocking dependencies.
- **Uncompilable Files**: The regex extraction completely ignores syntax errors, allowing dependency extraction to work on incomplete files.

## Extension Points

- **New Languages**: To support a new language (e.g., Go or C#), one only needs to add a new branch in the `extractSourceDependencies` regex matchers and adjust `resolveQualifiedName` if the language uses a non-dot-delimited path structure.
- **Custom Links**: The `addManualDependency` function (`sourceDeps.ts:117`) provides a native hook for external tools or UI interfaces to safely inject edges into the graph before `buildParallelPools` is evaluated.
