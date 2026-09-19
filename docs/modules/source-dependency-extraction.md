# Source Dependency Extraction and Pooling

## Purpose and Overview

The Source Dependency Extraction process (`migration/registry/commands/sourceDeps.ts`) is a critical sub-system of the initial codebase Inventory phase. Its primary responsibility is to discover structural relationships—such as imports and inheritance—between legacy artifacts.

Once these relationships are identified, the system builds a dependency-aware execution plan (parallel pools). This guarantees a safe modernization order where no file is processed concurrently with its direct dependencies or dependents, while maximizing parallelism for unrelated artifacts.

Crucially, the extraction logic is pure and deterministic. It is designed to work on raw, often broken legacy code without requiring a working compiler or language server.

## Architecture & Data Flow

### 1. Regex-Based Extraction
At the core of the module is `extractSourceDependencies`. Instead of building a full Abstract Syntax Tree (AST)—which is fragile and frequently fails on uncompilable legacy code—the system uses conservative, regex-based parsing.
- In **Java**, it looks for `import ...;`, `extends ...`, and `implements ...`.
- In **Python**, it captures `from ... import ...` and `import ...`.
This approach embraces a fail-safe philosophy: an over-eager regex might create a false positive dependency edge, which slightly reduces parallelism, but it will never compromise the correctness of the execution order.

### 2. Identifier Resolution
Extracted text must be mapped back to registered artifacts in the database. Functions like `resolveJavaFqcn` and `resolvePythonModule` delegate to `resolveQualifiedName`.
This resolver is resilient: it attempts to match fully qualified names (e.g., `com.legacy.Utils`) against the registered artifact IDs. If only a simple name is available, it attempts to resolve it, provided the simple name resolves to exactly one artifact in the workspace.

### 3. Cycle Collapsing (Tarjan's SCC)
Legacy codebases frequently contain circular dependencies (e.g., Class A imports Class B, and Class B imports Class A). A naive topological sort would loop infinitely or fail on these cycles.
To solve this, `collapseSCC` implements **Tarjan's Strongly Connected Components (SCC) algorithm**. This algorithm traverses the dependency graph and condenses mutually dependent artifacts into a single node. The result is a cycle-free, condensed Directed Acyclic Graph (DAG) that can be safely ordered.

### 4. Parallel Pool Building
With a condensed DAG in hand, `buildParallelPools` assigns execution order:
- It performs a longest-path walk over the DAG to assign a topological `level` to each component.
- Pools are emitted level by level.
- To handle cycles safely, artifacts that belong to a multi-node SCC (i.e., they are mutually dependent) are serialized relative to each other—each cycle member becomes its own singleton pool within that level.
- Unrelated singleton components at the same level are grouped into parallel pools up to the maximum concurrency limit (`parallel`).

## Invariants and Edge Cases

- **Uncompilable Code Resilience**: Because extraction is purely textual, missing SDKs, third-party libraries, or syntax errors do not halt the dependency graph construction. Unresolvable external imports are safely ignored.
- **Fail-Closed on Ambiguity**: If a simple class name (like `Utils`) matches multiple registered legacy artifacts, the resolver conservatively returns `null` rather than guessing wrong. Explicit fully-qualified imports resolve deterministically.
- **Manual Dependency Preservation**: `recordAutoDependencies` specifically clears links where `created_by = 'auto'`, ensuring that any manual overrides or edges added by human operators (`addManualDependency`) survive subsequent re-runs of the inventory phase.

## Extension Points

- **New Language Support**: The `extractSourceDependencies` function switches on a `SourceLang` type (`"java" | "python" | "other"`). Adding support for languages like C# or Go only requires adding new regex matchers to this function.
- **Cycle-Aware Prompts**: Currently, `buildParallelPools` forces cycle members to run serially. A future extension could use the output of `findCycles` to bundle mutually dependent files into a single context window for a multi-file modernization pass.
