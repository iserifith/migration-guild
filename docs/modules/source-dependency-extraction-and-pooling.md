# Source-Level Dependency Extraction and Pooling

## Purpose and Overview

In the Migration Guild pipeline, accurately determining execution order for legacy artifacts is critical. If artifact `A` depends on artifact `B`, modernizing `A` before `B` (or simultaneously) can lead to broken builds or missing context. The `sourceDeps` module (`migration/registry/commands/sourceDeps.ts`) provides deterministic source-level dependency extraction and dependency-aware pool generation.

Rather than using complex AST parsers that fail on uncompilable legacy code, it uses resilient, regex-based extraction to find `import`, `extends`, and `implements` links. It then builds safe, parallel execution pools, employing Tarjan's Strongly Connected Components (SCC) algorithm to handle the circular dependencies frequently found in legacy codebases.

## Architecture

The module is broken into two main phases: Extraction/Resolution, and Graph-Based Pool Generation.

1.  **Regex-Based Extraction (`extractSourceDependencies`)**: A deterministic parser reads raw file text and extracts dependency signals. The system explicitly trades precision for resilience—it is acceptable to find extra links (which only costs parallelism), but it must not miss actual dependencies.
2.  **Identifier Resolution (`resolveQualifiedName`)**: Extracted strings (like a Java FQCN or Python module path) are mapped to registered artifact IDs in the SQLite registry. If an identifier is ambiguous, it fails closed (ignores the link).
3.  **Graph Condensation (`collapseSCC`)**: To safely schedule jobs, the dependency graph must be a Directed Acyclic Graph (DAG). However, legacy code often contains cycles (e.g., A imports B, B imports A). Tarjan's SCC algorithm collapses these cycles into single nodes.
4.  **Topological Pooling (`buildParallelPools`)**: The condensed DAG is layered using a longest-path walk. Nodes at the same depth can be safely executed in parallel, up to a specified concurrency limit.

## Input, Output, and Failure Scenarios

-   **Input:** File content strings, language type (`java` | `python`), and the set of registered artifact IDs/aliases.
-   **Output:** An array of `SourceDep` objects containing `dependentId`, `dependencyId`, and the signal type (`import` or `inheritance`). For scheduling, it outputs an array of pools (`string[][]`), where each pool is an array of artifact IDs that can run concurrently.
-   **Failure Scenarios:**
    -   *Ambiguous Imports:* If an import string matches multiple registered artifacts, `resolveQualifiedName` returns `null`, producing no link.
    -   *Unresolvable Imports:* Third-party or JDK imports that aren't in the registry are safely ignored.
    -   *Cycles:* Cycles do not crash the scheduler; they are trapped and collapsed into sequential execution chunks.

## Rationale Behind Data Structures

### Deterministic Regex vs. AST
An AST parser demands syntactically valid code. Legacy code undergoing modernization is frequently broken, incomplete, or uses outdated syntax extensions. Regex provides a resilient, "best-effort" extraction that operates on raw text, ensuring the pipeline doesn't halt on compilation errors in the legacy source.

### DAGs and Tarjan's SCC
A standard topological sort on a dependency graph fails if the graph contains cycles. Because legacy Java applications often feature mutual imports, a strict DAG requirement would cause infinite loops or scheduling failures. Tarjan's Strongly Connected Components algorithm is used to find these cycles and treat them as a single logical unit. Members of an SCC cannot be safely parallelized, so they are grouped and ultimately serialized into separate singleton pools at the same topological level.

## Step-by-Step Flow

### 1. Dependency Extraction
The flow begins by scanning a source file. In `migration/registry/commands/sourceDeps.ts:extractSourceDependencies`, regular expressions match `import`, `extends`, and `implements` statements (for Java) or `import` and `from ... import` statements (for Python).

```typescript
// migration/registry/commands/sourceDeps.ts
for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
  push(resolveJavaFqcn(m[1], ids, aliases), "import");
}
```

### 2. Resolution and Persistence
Extracted paths are resolved against known artifact IDs using `migration/registry/commands/sourceDeps.ts:resolveQualifiedName`. The links are then persisted to the `source_dependencies` SQLite table via `recordAutoDependencies`. Prior auto-extracted links for the artifact are cleared, but manual links (`created_by = 'manual'`) are preserved.

### 3. Cycle Collapse
When it's time to build execution pools, the system fetches all dependencies for first-class artifacts. It calls `migration/registry/commands/sourceDeps.ts:collapseSCC`, which implements Tarjan's algorithm. This traverses the nodes, identifying components where every node can reach every other node (cycles).

### 4. Level Assignment and Pooling
`migration/registry/commands/sourceDeps.ts:buildParallelPools` creates a condensed graph where each SCC is a node. It assigns a topological level to each component using a longest-path calculation:
```typescript
const visit = (c: number): number => {
  if (level.has(c)) return level.get(c)!;
  let lvl = 0;
  for (const d of compDeps.get(c)!) lvl = Math.max(lvl, visit(d) + 1);
  level.set(c, lvl);
  return lvl;
};
```
Finally, it groups artifacts at the same level into parallel pools (arrays of arrays), respecting the maximum `parallel` concurrency parameter. Cycle members are emitted as singleton pools to ensure they run serially relative to each other.

## Invariants and Edge Cases

-   **Parallelism Safety:** No artifact will ever share a pool with an artifact it depends on, or an artifact that depends on it.
-   **Manual Override Priority:** Dependencies added manually (`addManualDependency`) have a `created_by` of `'manual'` and are never deleted by the automated `recordAutoDependencies` process.
-   **Generics Handling:** When extracting Java `extends` or `implements`, generics like `List<MyType>` are handled by splitting tokens on `<,>, ` and extracting the base identifier, preventing parsing failures.
-   **Name Collisions (Fail Closed):** If an import only specifies a class name (e.g., `import MyClass`) and the registry contains multiple artifacts ending in `MyClass`, `resolveQualifiedName` refuses to guess and drops the link.

## Extension Points

The extraction logic in `extractSourceDependencies` is strictly partitioned by `lang: SourceLang`. To add support for new languages (e.g., `javascript` or `typescript`), one only needs to add a new `else if (lang === 'typescript')` block with appropriate regexes for `import` and `export` statements, and implement a corresponding `resolveTypeScriptModule` helper. The downstream graph and SCC logic is language-agnostic and will handle the new links automatically.
