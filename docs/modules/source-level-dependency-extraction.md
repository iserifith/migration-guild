# Source-Level Dependency Extraction & Topological Pooling

## Purpose and Overview

The **Source-Level Dependency Extraction** subsystem (`migration/registry/commands/sourceDeps.ts`) is responsible for parsing legacy source code to discover relationships between artifacts, and then structuring those artifacts into safe, parallel execution pools.

During the `inventory` stage, after artifacts are discovered on the filesystem, the pipeline needs to know which files depend on which others. Rather than relying on an LLM—which can hallucinate edges or miss subtle imports—or a heavy AST parser—which breaks on uncompilable legacy code—the extraction relies on **deterministic, regex-based heuristic parsing**.

Once extracted, the subsystem computes a Dependency DAG (Directed Acyclic Graph). Because legacy code often contains circular dependencies (mutual imports), it implements **Tarjan's Strongly Connected Components (SCC) algorithm** to collapse these cycles. Finally, it uses longest-path topological layering to generate parallel execution pools (`buildParallelPools`), ensuring that an artifact is never migrated before its upstream dependencies.

## Architecture and Scope

This subsystem is purely deterministic and stateless (it doesn't rely on LLMs or external network calls). It exposes its core logic in `migration/registry/commands/sourceDeps.ts`:

1.  **Resolution (`resolveQualifiedName`)**: Maps a raw code import string (e.g., `com.company.utils.DateHelper`) to a registered database artifact ID.
2.  **Extraction (`extractSourceDependencies`)**: Scans raw file text for language-specific import/inheritance signatures.
3.  **Cycle Detection (`collapseSCC`)**: Applies Tarjan's algorithm to find cyclic dependencies.
4.  **Pool Generation (`buildParallelPools`)**: Groups artifacts into ordered execution waves (pools) based on the dependency DAG.

## Step-by-Step Flow and Mechanics

### 1. Regex-Based Heuristic Extraction

Extraction is invoked during the inventory phase (`migration/guildctl/commands/inventory.ts:scanAndRegister`). For each registered source file, `extractSourceDependencies` (`migration/registry/commands/sourceDeps.ts:57`) is called.

**Why Regex instead of an AST?**
As stated in the code's comments (`migration/registry/commands/sourceDeps.ts:4`), the strategy is: *"The conservative direction is extra links, which only costs parallelism, never correctness."* An AST parser fails completely on syntax errors (common in mid-migration states), whereas a regex will robustly extract whatever imports exist.

The extraction supports multiple languages (`SourceLang`):
-   **Java**: Scans for `import` statements and class declarations (`extends`, `implements`). Inheritance is treated as a dependency edge. Generics are loosely stripped by splitting on `<,>`.
-   **Python**: Scans for `from ... import ...` and plain `import` statements.

Once extracted, a raw name is mapped to a known `artifact_id` using `resolveQualifiedName`. It handles exact matches, alias mapping, and fallback simple-name matching. The resulting edges are persisted to the database via `recordAutoDependencies`.

### 2. Collapsing Cycles (Tarjan's Algorithm)

Legacy code is notorious for circular dependencies (Artifact A imports Artifact B, which imports Artifact A). A naive topological sort over a cyclic graph never terminates.

To solve this, `collapseSCC` (`migration/registry/commands/sourceDeps.ts:167`) implements **Tarjan's strongly connected components algorithm**.
-   It performs a depth-first search to find groups of nodes that are mutually reachable.
-   Every node in the graph is mapped to a specific "component ID".
-   If a cycle exists, all members of that cycle are merged into a single component.

By treating components (rather than individual files) as the nodes of the graph, the cyclic graph is transformed into a Condensed Directed Acyclic Graph (DAG).

### 3. Topological Layering and Pool Generation

To maximize migration speed while maintaining correctness, the pipeline groups independent artifacts into concurrent execution pools via `buildParallelPools` (`migration/registry/commands/sourceDeps.ts:211`).

1.  **DAG Construction**: It rebuilds the graph edges between the collapsed components (`compDeps`).
2.  **Longest-Path Layering**: It calculates the "level" of each component. A component's level is defined as `1 + Max(levels of its dependencies)`. This guarantees that a component only appears in a pool after all its dependencies have been fully resolved.
3.  **Pool Emission**:
    -   Components at the same level do not depend on each other and can safely run in parallel.
    -   If a component contains multiple artifacts (because it was part of a cycle), those cycle members *cannot* be run in parallel with each other safely. They are grouped into singleton pools at the same level, forcing the runner to serialize them.
    -   Independent artifacts at the same level are chunked into pools based on the operator's `--parallel` limit.

## Invariants and Edge Cases

-   **Cycle Serialization Invariant**: If Artifact A and Artifact B form a cycle, they will be placed in the same execution level, but in *separate* singleton pools. The runner enforces that pools are drained serially relative to each other within a cycle, preventing race conditions where both agents try to fix the cycle simultaneously.
-   **Ambiguous Resolution**: If an import string matches multiple registered artifacts (and no strict fully-qualified match or alias resolves the tie), `resolveQualifiedName` safely returns `null`. This drops the edge, trading a potential dependency failure later for preventing a completely stalled graph.
-   **Manual Overrides**: The auto-extracted links are stored with `created_by = 'auto'`. The database schema allows operators to inject manual dependencies (`addManualDependency`), which are preserved across re-scans because `recordAutoDependencies` specifically restricts its `DELETE` operation to `'auto'` records.

## Gotchas and Extension Points

-   **Adding New Languages**: To support a new language (e.g., C# or Go), you must add its module/import regex heuristics to `extractSourceDependencies`. Because the extraction operates purely on text matching, adding a language does not require linking complex AST parser libraries.
-   **Conservative Over-linking**: Because Java wildcard imports (`import java.util.*;`) or overly broad regexes might accidentally link unrelated files, you may occasionally see smaller parallel pools than expected. Remember the design goal: false positive dependencies reduce parallelism, but false negatives break compilation.
