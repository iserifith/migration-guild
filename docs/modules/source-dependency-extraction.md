# Source-Level Dependency Extraction & Pooling

## Purpose and Overview

The **Source-Level Dependency Extraction** subsystem (`migration/registry/commands/sourceDeps.ts`) is a critical component of the `inventory` pipeline stage. Its purpose is to map out the structural dependency graph of a legacy codebase (e.g., determining which Java classes import which other classes).

Unlike modern build systems, the Migration Guild pipeline intentionally **avoids AST parsers** (Abstract Syntax Trees) for this step. Legacy codebases are often uncompilable, missing dependencies, or using deprecated language features that break strict AST parsers. Instead, this module uses deterministic, regex-based parsing to extract relationships. This fail-safe approach guarantees that the system can always build a dependency graph, even for heavily broken code.

Crucially, this subsystem doesn't just extract links; it resolves circular dependencies. Legacy systems are rife with mutual imports. Since cyclic graphs cannot be topologically sorted, this module employs **Tarjan's Strongly Connected Components (SCC)** algorithm to identify cycles and collapse them into single execution units, allowing the autonomous planner to safely generate parallel migration waves.

## Architecture

The extraction and pooling logic is fully pure and deterministic (meaning it operates without LLM intervention), relying on three main operations:

1. **Extraction (`extractSourceDependencies`)**: A regex-based scanner that reads raw source code and yields dependency edges.
2. **Resolution (`resolveQualifiedName`)**: A fallback-driven naming resolver that maps raw import statements back to formal registry `artifact_id`s.
3. **Pooling (`buildParallelPools`)**: A graph processor that uses Tarjan's SCC algorithm to detect cycles, collapse the graph into a Directed Acyclic Graph (DAG), and group artifacts into safe, parallel execution levels.

## Step-by-Step Flow

### 1. Regex-Based Extraction

During the inventory stage, `extractSourceDependencies` (`migration/registry/commands/sourceDeps.ts:57`) is called for every readable source file.
- The function receives the raw string content of a file and uses simple regular expressions (e.g., `/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm` for Java) to find `import` statements.
- It also uses inheritance signals (`extends` or `implements`) for deeper structural coupling.
- It deduplicates within the file and returns a list of raw `SourceDep` objects containing the extracted `dependencyId` (if it can be resolved).

### 2. Artifact ID Resolution

Raw import strings (like `com.example.utils.Formatter`) must be linked to concrete artifacts in the SQLite registry (like `legacy-source:default:Formatter`). This is handled by `resolveQualifiedName` (`line 20`).
- It parses the simple name (the final segment of the path).
- It attempts to find an exact match in the `ids` Set provided by the registry.
- It leverages an `aliases` map for complex nested resolutions.
- If multiple artifacts share the same simple name (e.g., two `Utils` classes in different packages) and the import isn't fully qualified enough to disambiguate, it fails closed (returning `null`) to prevent false-positive links.

### 3. Tarjan's SCC and Graph Condensation

Once all dependencies are stored in the `source_dependencies` SQLite table, the planner needs to divide the work. It cannot simply traverse the graph, as cyclic dependencies would cause infinite loops.
`buildParallelPools` (`line 207`) handles this:

1.  **Cycle Detection**: It pulls all known edges from SQLite and passes them to `collapseSCC` (`line 160`).
2.  **Tarjan's Algorithm**: `collapseSCC` is a pure implementation of Tarjan's algorithm. It performs a depth-first search, tracking `idx` and `low` link values for each node. When a cycle is detected, all nodes in that cycle are popped off a stack and grouped into a single Strongly Connected Component (SCC).
3.  **Graph Condensation**: Back in `buildParallelPools`, the algorithm builds a condensed DAG (`compDeps`) where each node is an SCC (which may contain one or multiple original artifacts). All edges between artifacts in different SCCs become edges between the SCCs themselves.
4.  **Topological Layering**: It assigns a level to each SCC using a longest-path walk. SCCs with no dependencies are Level 0. If SCC `A` depends on SCC `B`, `A`'s level is `B`'s level + 1.

### 4. Pool Generation

Finally, `buildParallelPools` yields the execution layout:
- It iterates through the topological levels.
- **Singletons**: Components with only one member are batched into arrays of `parallelN` size. These can be migrated concurrently.
- **Cycles**: Components with multiple members (the mutual imports) **must be run serially** relative to each other within that level. Thus, each member of a cycle becomes its own singleton pool, forcing the loop to handle them one by one without parallelism to prevent race conditions during code rewriting.

## Invariants and Edge Cases

- **Fail-Closed Resolution**: If `resolveQualifiedName` finds multiple potential targets for an import and cannot disambiguate, it returns `null` rather than guessing. Missing a dependency edge is safer than forging an incorrect one (which could severely delay the wave planner).
- **Cycle Serialization Constraint**: The system strictly forbids running two mutually dependent artifacts in parallel. `buildParallelPools` guarantees that multi-node SCCs are emitted as separate pools of size 1.
- **Pure Determinism**: `collapseSCC` and `buildParallelPools` have no side effects and do not mutate SQLite. They are pure graph functions, ensuring that identical registry states always produce identical execution plans.

## Gotchas and Extension Points

- **Regex Limitations**: The `extractSourceDependencies` regexes are intentionally greedy. They might match commented-out imports or string literals. This is an accepted trade-off; extra links only cost parallelism (by forcing things to run sequentially), they never compromise correctness.
- **Adding New Languages**: To support dependency extraction for a new language (e.g., Go or C#), you only need to add a new case to the `if (lang === ...)` block inside `extractSourceDependencies` with the appropriate regex for that language's import syntax. The Tarjan SCC and pooling logic remains language-agnostic.
