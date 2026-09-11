# Source Dependencies and Parallel Pools

## Purpose and Overview

The **Source Dependencies and Parallel Pools** subsystem (`migration/registry/commands/sourceDeps.ts`) provides deterministic analysis of how raw legacy source files interrelate and uses that data to structure execution parallelization.

When the migration framework needs to safely divide work across multiple LLM agent instances (the "pools"), it must guarantee that no artifact runs concurrently with anything it depends on or anything that depends on it. A naive scanner cannot solve this, particularly for legacy codebases laden with uncompilable code and circular dependencies. Therefore, this subsystem relies on robust regex-based extraction and advanced graph processing (Tarjan's SCC algorithm) to emit safe serialization boundaries.

## Architecture

The system operates in two core phases:

1. **Extraction (`extractSourceDependencies`)**: A static, language-specific scan over source content that produces a raw list of potential dependencies.
2. **Graph Construction and Serialization (`buildParallelPools`)**: Processes the dependency links, isolates circular reference cycles (SCCs), and assigns components to strictly ordered topological levels to safely execute in parallel pools.

## Step-by-Step Flow

### 1. Source Dependency Extraction

The `extractSourceDependencies` function parses raw text using deterministic regular expressions instead of Abstract Syntax Tree (AST) parsers.

**Why Regex over AST?**
Legacy code is often incomplete, uncompilable, or contains syntax errors that cause full AST parsers to crash. Regex provides a resilient fallback. The design consciously accepts *extra* potential links (false positives) because overestimating dependencies only reduces parallelism; it never compromises correctness.

- **Java**: Scans for `import` statements and `extends` / `implements` inheritance markers.
- **Python**: Scans for `from X import Y` and `import X`.

These matched symbols are then passed to `resolveQualifiedName`, which checks them against the known registry IDs to ensure we only track internal first-class artifacts (e.g. `legacy-source:default:MyClass`).

### 2. Graph Construction & Tarjan's SCC Algorithm

Once all dependencies are extracted and saved via `recordAutoDependencies` to the `source_dependencies` SQLite table, the system builds an execution graph in `buildParallelPools`.

The first challenge in graph construction is circular dependencies (e.g., A depends on B, and B depends on A), which are prevalent in legacy code. A standard topological sort on a cyclic graph will fail or loop infinitely.

To solve this, the subsystem uses **Tarjan's Strongly Connected Components (SCC) algorithm** (`collapseSCC`).
- The algorithm walks the entire graph.
- Any cycle (mutual import) is isolated and collapsed into a single "Strongly Connected Component".
- For the purposes of pooling, cycle members are forced to run serially relative to each other by treating the entire cycle as a single node in the condensed graph.

### 3. Topological Level Assignment and Pooling

With cycles condensed, the graph is now a strict Directed Acyclic Graph (DAG). `buildParallelPools` then computes a topological level assignment via a longest-path walk.

- A component's level is determined by the maximum path length from the root.
- A pool can only contain components from the same topological level.
- Because same-level components never link to each other, they are completely safe to execute concurrently in parallel agents.

Finally, the pools are chunked by the configured concurrency limit (`parallelN`). The pipeline orchestrator can drain these pools sequentially, guaranteeing that a dependency always finishes its migration before its dependent begins.

## Invariants and Edge Cases

- **Deterministic Resolution**: Name resolution handles ambiguous names deterministically. If an imported simple name (e.g., `Utils`) matches multiple registered artifacts and cannot be uniquely qualified, it is defensively ignored rather than creating an incorrect link.
- **Cycle Parallelism Restriction**: If components are mutually dependent (in the same SCC), they cannot share a pool. The algorithm explicitly splits multi-node SCCs into individual singleton pools that run serially, preventing race conditions where both files try to adapt to each other simultaneously.
- **Fail-Safe Extraction**: If a file cannot be read from the filesystem, it yields zero dependencies and falls back safely, meaning the file will still be planned but might lack priority ordering.

## Gotchas and Extension Points

- **Adding Languages**: To support a new language, you do not need an AST parser. Simply add a new clause to `extractSourceDependencies` with the relevant `import` or `require` regexes, and the rest of the pooling pipeline will seamlessly support it.
- **Manual Overrides**: The system supports `addManualDependency` to inject missing links that regex couldn't catch (e.g., reflection-based instantiation). Manual dependencies carry a `manual` signal and are preserved even if `recordAutoDependencies` re-scans the file.
