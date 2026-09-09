# Source-Level Dependency Extraction & Parallel Pooling

## Purpose and Overview

In the Migration Guild pipeline, before an autonomous AI planner can safely dispatch code modernization tasks, it must understand the intrinsic dependency graph of the legacy source code. If a high-level service is migrated before the low-level utilities it depends on, the build will break, and the AI agent will lack the necessary context to complete its task.

The **Source-Level Dependency Extraction** subsystem (`migration/registry/commands/sourceDeps.ts`) solves this by deterministically building a dependency graph directly from the raw legacy source files. It avoids brittle AST parsers (which often fail on uncompilable or incomplete legacy code) in favor of regex-based heuristics.

Once the graph is extracted, it employs graph theory algorithms—specifically Tarjan's Strongly Connected Components (SCC) and longest-path topological sorting—to safely group interconnected files into ordered, parallel-executable **pools**.

## Architecture

The subsystem operates through a pipeline of three deterministic steps, entirely bypassing LLMs to guarantee correctness and speed:

1. **Extraction (`extractSourceDependencies`)**: Scans source text using language-specific regular expressions to identify imports and class inheritance.
2. **Cycle Collapse (`collapseSCC`)**: Uses Tarjan's algorithm to find and collapse circular dependencies (which are common in legacy monolithic Java) into single executable units.
3. **Topological Pooling (`buildParallelPools`)**: Groups the condensed acyclic graph into horizontal layers (levels) that can be safely processed in parallel by downstream autonomous agents.

## Step-by-Step Flow

### 1. Extraction via Regex

Rather than relying on a heavy compiler frontend, `extractSourceDependencies` uses simple but effective regular expressions. For Java, it looks for `import ...;` statements and `extends / implements` clauses. For Python, it looks for `from ... import ...` and `import ...`.

**Key Invariant: Over-extraction is safe.**
The agreed architectural bar is that a regex might accidentally extract extra, phantom links (e.g., from commented-out code). This is considered a safe failure mode: extra links only cost parallelism by forcing sequential execution, but they *never* cost correctness. Missing a link would break the build, but false positives do not.

**Resolution (`resolveQualifiedName`):**
Extracted raw strings (like `com.acme.Subscription`) are resolved against the known registry IDs. The resolver handles both fully-qualified names and simple class names (e.g., matching a bare `Shared` to `legacy-source:app:Shared`), mapping aliases where necessary. If a simple name resolves ambiguously to multiple artifacts, it fails safely (returns `null`) rather than guessing incorrectly.

### 2. Collapsing Circular Dependencies (Tarjan's SCC)

Legacy codebases frequently contain cyclic dependencies (e.g., Class A imports Class B, and Class B imports Class A). A naive topological sort over a cyclic graph will infinite-loop.

To solve this, the subsystem uses `collapseSCC`, an implementation of **Tarjan's Strongly Connected Components** algorithm.

```typescript
// From migration/registry/commands/sourceDeps.ts
export function collapseSCC(nodes: string[], edges: Array<[string, string]>): string[][] {
  // ... Tarjan's implementation ...
}
```

**How it works:**
1. It performs a depth-first search (DFS) over the dependency edges.
2. It tracks the `index` (discovery time) and `low` (the lowest index reachable from the current node).
3. When `low === index`, a complete cycle (a strongly connected component) has been found.
4. All nodes in that cycle are popped off the stack and grouped into a single array (`string[]`).

**Result:** The output is a condensed DAG (Directed Acyclic Graph) where each node is now a *component* (an array of one or more artifacts).

### 3. Topological Leveling & Parallel Pooling

With a guaranteed DAG, `buildParallelPools` assigns each component to an execution level.

1. **Level Assignment**: It performs a longest-path walk over the condensed DAG. A component is assigned a level equal to `max(level of dependencies) + 1`. This ensures that a component is only scheduled *after* all its transitive dependencies are scheduled.
2. **Pool Generation**: The components are grouped by their level.
3. **Cycle Constraints**: If a component contains multiple artifacts (a cycle found by Tarjan's), the entire cycle is emitted as a series of *singleton pools*. Cycle members must run serially relative to each other (or be handled by a specialized multi-file agent), so they are never grouped into a parallel chunk.
4. **Parallel Chunking**: For singleton components at the same level, they are chunked into arrays of size `parallelN` (e.g., chunks of 4) to maximize throughput.

## Invariants and Edge Cases

- **Cycle Serialization Invariant**: No pool contains a linked pair of dependencies. Furthermore, members of a cycle (a multi-node SCC) are strictly serialized into singleton pools of size 1. This is verified in `test/source-deps-pools.test.ts`.
- **Fail-Closed Resolution**: Ambiguous simple name resolutions (e.g. `import Shared;` when two packages have a `Shared` class) return `null` instead of guessing.
- **Auto vs Manual Links**: The database explicitly tracks whether a link was `auto` (created by regex) or `manual`. Re-running the extractor replaces `auto` links but preserves `manual` links, allowing human operators to inject critical hidden dependencies via the CLI (e.g. `guildctl deps add`).

## Gotchas

- **Typescript / AST Tools:** It may be tempting to replace the regex with an AST tool (like `ts-morph` or `javaparser`). However, the legacy code is often completely un-compilable or missing classpath references. The regex approach is intentionally chosen for its resilience against malformed inputs.
- **Topological Tie-breaking:** Components at the exact same level do not have a guaranteed stable order relative to each other beyond insertion/iteration order, but because they have no dependencies on each other, any parallel execution order is safe.

## Extension Points

- **New Languages**: Adding a new language simply requires adding a new block in `extractSourceDependencies` to capture its import syntax, and updating the `SourceLang` union. The graph resolution and Tarjan's algorithm are entirely language-agnostic.
- **Advanced Heuristics**: If dependency rules evolve, new heuristic matchers (like detecting XML-based Spring bean references) can be added to the extraction pass without changing the underlying DAG mechanics.