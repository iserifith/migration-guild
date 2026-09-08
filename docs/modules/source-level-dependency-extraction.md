# Source-Level Dependency Extraction

## Overview & Purpose

The source-level dependency extraction subsystem in `migration-guild` is responsible for parsing legacy code to infer dependency graphs, and then building safe, parallel execution pools for the autonomous pipeline runner.

Unlike traditional compilation toolchains that rely on Abstract Syntax Trees (ASTs) to determine dependencies, `migration-guild`'s source dependency extraction is **purely regex-based**. This is an intentional architectural choice: legacy code often exists in an uncompilable state (due to missing dependencies, syntax errors, or environmental rot). An AST parser would choke on such files, whereas regex-based token extraction degrades gracefully and simply extracts what it can see. The conservative assumption here is that extra, spurious links only cost pipeline parallelism (by grouping things together), but never correctness.

The core logic for this subsystem is entirely contained within `migration/registry/commands/sourceDeps.ts`.

## Architecture & Mechanisms

### 1. Regex-Based Extraction

The `extractSourceDependencies` function (`migration/registry/commands/sourceDeps.ts:extractSourceDependencies`) is the entry point for parsing file contents. It handles two signals: `import` and `inheritance`.

*   **Java:**
    *   Imports are captured via `/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm`.
    *   Inheritance is captured by scanning for `extends` or `implements` followed by type lists. It handles simple generics by splitting on `<>`, `,`, and spaces, and plucking out the raw identifiers.
*   **Python:**
    *   It captures `from X import Y` and simple `import X` constructs.

### 2. Resolution (`resolveQualifiedName`)

Once a raw token (like a fully-qualified class name or Python module path) is extracted, it must be mapped back to a registered artifact ID. This happens in `resolveQualifiedName` (`migration/registry/commands/sourceDeps.ts:resolveQualifiedName`), which is wrapped by language-specific helpers (`resolveJavaFqcn` and `resolvePythonModule`).

The resolution strategy is multi-tiered:
1.  **Exact Match:** Does the extracted token exactly match an artifact ID ending?
2.  **Legacy Prefix Matching:** If it has qualifiers (like `com.example.Service`), it attempts to synthesize a `legacy-source:` ID to match against known artifacts.
3.  **Alias Matching:** It checks against the `aliases` map, handling renamed or historically mapped modules.
4.  **Simple Name Fallback:** If the token lacks qualifiers (a simple class name), it looks for *any* registered ID ending in that simple name. If it finds exactly one, it binds it. If it finds multiple, it bails out (returning `null`) to avoid incorrectly linking ambiguous names.

## Graph Processing & Pooling

Once dependencies are extracted and resolved to artifact IDs, they form a directed dependency graph. The runner needs to know which artifacts can be processed in parallel. If artifact A depends on B, A must wait for B.

### 1. Cyclic Dependency Resolution (Tarjan's SCC)

A major problem in legacy code (especially Java) is mutual imports or cyclic dependencies (A imports B, and B imports A). If a naive graph traversal is used, it will infinite loop. If parallel pools try to separate them, a deadlock occurs.

To solve this, `migration-guild` uses Tarjan's Strongly Connected Components (SCC) algorithm, implemented in `collapseSCC` (`migration/registry/commands/sourceDeps.ts:collapseSCC`).

This algorithm walks the dependency graph and identifies cycles. Every node in a cycle is collapsed into a single "Strongly Connected Component". These components are treated as single serialization units—meaning all members of a cycle are grouped together and forced into the same pool to be processed sequentially, ensuring the cycle doesn't break the parallel runner.

### 2. Topological Pool Generation

Once cycles are collapsed, the graph is a pure Directed Acyclic Graph (DAG) of components. The `buildParallelPools` function (`migration/registry/commands/sourceDeps.ts:buildParallelPools`) converts this DAG into execution batches.

It uses a "longest-path layering" approach:
1.  It calculates a topological level for each component (a node's level is `1 + MAX(levels of its dependencies)`).
2.  It groups components by their level.
3.  Components at level `L` are completely independent of each other (because any dependency link forces a higher level), and they only depend on components at levels `< L`.
4.  It chunks the independent components at level `L` into pools constrained by the `parallel` argument.
5.  Multi-node components (cycles collapsed by SCC) are emitted as their own singleton pools to ensure they run sequentially without interference from other parallel tasks.

## Database Interactions

The resolved dependencies are persisted in the SQLite registry. The database constraints enforce the distinction between auto-discovered and manual dependencies.

*   **`recordAutoDependencies`:** This function runs in a transaction. Crucially, it only deletes prior dependencies for the `dependent_id` where `created_by = 'auto'`. It then inserts the new links. This preserves any manual dependency links added by users or other agents.
*   **`addManualDependency` & `removeDependency`:** Used for explicit overrides. Manual links are flagged as `'manual'`.
*   **`listDependencies` & `findCycles`:** Utility read queries. `findCycles` leverages the `collapseSCC` logic to report existing cycles back to the user or runner.
