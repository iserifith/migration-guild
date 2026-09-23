# Source-Level Dependency Extraction & Pooling

## Purpose and Overview

The **Source-Level Dependency Extraction** subsystem (`migration/registry/commands/sourceDeps.ts`) is responsible for building a dependency graph of legacy artifacts entirely from their raw source code, without requiring the code to compile or relying on complex, brittle AST parsers.

This graph is a foundational pillar for the Autonomous Loop, as it dictates the execution order of modernization tasks. By mapping `import`, `extends`, and `implements` statements directly to registered artifact IDs, the system builds an acyclic execution graph that guarantees low-level dependencies are migrated (and verified) before the higher-level components that rely on them.

A critical design choice is that this extraction uses **deterministic, regex-based parsing**. The conservative philosophy is that it is acceptable to have *extra* dependency links (which merely limits parallelism) but never acceptable to miss a link (which would result in broken, out-of-order execution).

## Architecture & Data Flow

The subsystem has two major responsibilities: extracting the edges, and sorting those edges into safe, parallel execution pools.

### 1. Regex-Based Extraction (`extractSourceDependencies`)

The extraction function receives the raw string content of a single artifact.

- **Implementation**: It uses language-specific Regular Expressions.
  - For Java, it finds `import [static] ...;` and `extends / implements ... {`.
  - For Python, it finds `from ... import ...` and `import ...`.
- **Resolution**: Extracted symbols (like a Java Fully-Qualified Class Name) are passed to `resolveQualifiedName`. This function attempts to map the simple class name or qualified path to an artifact already present in the registry's `first-class` set (with fallback to an aliases map).
- **Outcome**: It returns an array of `SourceDep` edges, marking the relationship as either an `import` or an `inheritance`.

### 2. Edge Persistance & Manual Overrides (`recordAutoDependencies`)

The edges are then stored in the SQLite `source_dependencies` table.
- **Fail-Safe Mechanism**: The `recordAutoDependencies` function deletes any previous edges marked with `created_by = 'auto'` and inserts the new ones.
- **Manual Invariant**: The query uses an `INSERT OR IGNORE` strategy. If a human operator has manually added a critical missing link using `addManualDependency` (marked as `created_by = 'manual'`), the automatic scanner will never overwrite or drop it.

### 3. Cycle Collapsing (`collapseSCC`)

Legacy codebases frequently contain cyclic dependencies (e.g., mutually dependent classes). However, a standard topological sort on a cyclic graph will never terminate or will produce invalid layers.

- **Mechanism**: The subsystem uses **Tarjan's Strongly Connected Components (SCC)** algorithm to find cycles.
- **Outcome**: Each cycle is condensed into a single "super-node" in a new Condensed Directed Acyclic Graph (DAG). Artifacts in the same cycle are grouped together, ensuring they will be serialized into the same pool and won't violate dependency guarantees relative to each other.

### 4. Parallel Pool Generation (`buildParallelPools`)

With a true DAG established, the subsystem generates execution waves.

- **Layering**: It performs a longest-path walk over the condensed DAG. Each node is assigned a depth layer. If artifact A depends on artifact B, A's layer will strictly be at least `B's layer + 1`.
- **Pool Generation**: Artifacts at the same layer are guaranteed to have no dependencies on each other. The system batches them into arrays (constrained by a `parallel` width argument).
- **Cycles**: If an SCC contained multiple members (a cycle), each member is output as its own singleton pool at that layer, enforcing that they are processed serially by the runner.

## Invariants and Edge Cases

- **Conservative Resolution (`resolveQualifiedName`)**: If a simple class name (e.g., `Utils`) resolves to *multiple* registered artifacts and lacks a package qualifier to disambiguate, the resolver intentionally returns `null`. Ambiguous resolution is dropped rather than creating a massive fan-out of false edges.
- **Uncompilable Code**: Because it is regex-based, the scanner successfully extracts edges even if the legacy file is missing brackets, has syntax errors, or imports libraries that aren't on the classpath.
- **Generics Stripping**: When parsing `extends HashMap<String, Value>`, the regex explicitly splits on `<,> ` tokens, ensuring the extractor correctly registers `HashMap` while ignoring the generic type arguments.

## Gotchas

- **Dynamic Imports**: Language constructs like Python's `importlib.import_module('...')` or Java's `Class.forName(...)` are entirely invisible to the static regex scanner. These will miss dependency edges and require `addManualDependency` to correct execution order.

## Extension Points

- **New Languages**: To support a new language (e.g., TypeScript or C#), one only needs to add a new `if (lang === "typescript")` block in `extractSourceDependencies` with regex matchers for `import { ... } from ...`. The rest of the pooling and SCC logic is entirely language-agnostic.
