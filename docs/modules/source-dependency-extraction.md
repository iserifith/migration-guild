# Source Dependency Extraction and Parallel Pooling

## Purpose and Overview

In the Migration Guild's pipeline, dependencies between legacy artifacts define the execution order for migration agents. An agent cannot safely migrate or analyze a dependent class if its dependencies haven't yet been processed.

The source dependency extraction system handles discovering these dependencies deterministically without requiring a full AST parser or build tools. Instead, it relies on conservative regex-based parsing to build a directed graph of relationships. This graph is then analyzed and flattened into "parallel pools" — groups of artifacts that can be safely processed at the same time by concurrent agent runners.

This deep-dive maps how dependencies are extracted from raw source, how cyclic dependencies (which are common in legacy code) are collapsed safely, and how the runner pool execution order is derived.

## Architecture and Scope

The dependency and pooling logic is isolated entirely within `migration/registry/commands/sourceDeps.ts`.

The subsystem is responsible for:
1. **Extraction**: `extractSourceDependencies` regex-parses source files (Java, Python) and maps import/inheritance declarations to registered artifacts using `resolveQualifiedName`.
2. **Persistence**: `recordAutoDependencies` commits these extracted relationships into the SQLite registry while preserving any human-provided `manual` links.
3. **Cycle Collapse**: `collapseSCC` implements Tarjan's Strongly Connected Components algorithm to find cyclic dependencies and condense them into serial groups.
4. **Pool Generation**: `buildParallelPools` takes the condensed Directed Acyclic Graph (DAG) and layers it via a longest-path walk, grouping independent nodes into concurrent execution pools.

---

## Step-by-Step Flow and Mechanics

### 1. Regex-Based Extraction (`extractSourceDependencies`)

Because legacy code is often un-compilable or contains syntax errors, the Guild avoids brittle AST parsers. Instead, `extractSourceDependencies` scans the file contents for language-specific keywords.

For **Java**, it looks for `import` statements, as well as `extends` and `implements` keywords:
```typescript
// migration/registry/commands/sourceDeps.ts:extractSourceDependencies
if (lang === "java") {
  for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
    push(resolveJavaFqcn(m[1], ids, aliases), "import");
  }
  // ...
```
For **Python**, it matches `import X` and `from X import Y` patterns.

Every matched string is passed to `resolveQualifiedName`. This function checks the discovered string (like `com.example.LegacyManager`) against the `ids` set (all known artifacts in the SQLite registry) and an `aliases` map. If it matches exactly one artifact, it returns that `dependencyId`, filtering out unresolvable or standard library imports.

### 2. Persisting Auto-Dependencies

Once extraction completes, the resulting `SourceDep[]` array is written to SQLite via `recordAutoDependencies`:

```typescript
// migration/registry/commands/sourceDeps.ts:recordAutoDependencies
const tx = db.transaction(() => {
  db.prepare(
    "DELETE FROM source_dependencies WHERE dependent_id = ? AND created_by = 'auto'",
  ).run(dependentId);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO source_dependencies (dependent_id, dependency_id, signal, created_by) VALUES (?, ?, ?, 'auto')",
  );
  // ...
```

Notice the hardcoded `'auto'` filter in the `DELETE`. This ensures that if the extraction regex is run a second time (e.g., if a file is updated), it drops the old auto-generated dependencies and writes the new ones, but strictly preserves any dependencies an operator added manually (`created_by = 'manual'`).

### 3. Collapsing Cycles (Tarjan's SCC)

Legacy codebases frequently contain mutual imports (e.g., `ClassA` imports `ClassB`, and `ClassB` imports `ClassA`). If the runner attempted a topological sort on a graph with cycles, it would either fail or enter an infinite loop.

To resolve this, `buildParallelPools` first passes the graph edges into `collapseSCC`, an implementation of Tarjan's Strongly Connected Components algorithm.

```typescript
// migration/registry/commands/sourceDeps.ts:collapseSCC
export function collapseSCC(nodes: string[], edges: Array<[string, string]>): string[][] {
// ...
```

This returns an array of components, where each component is an array of one or more node IDs. If two classes mutually depend on each other, they are grouped into a single component array. The result is a condensed graph that is guaranteed to be a DAG.

### 4. Building the Execution Pools

With the DAG in hand, `buildParallelPools` determines the execution order using a longest-path layering approach.

```typescript
// migration/registry/commands/sourceDeps.ts:buildParallelPools
const level = new Map<number, number>();
const visit = (c: number): number => {
  if (level.has(c)) return level.get(c)!;
  let lvl = 0;
  for (const d of compDeps.get(c)!) lvl = Math.max(lvl, visit(d) + 1);
  level.set(c, lvl);
  return lvl;
};
```

1. **Layering**: Every node is assigned a `level`. A node's level is exactly 1 higher than the maximum level of its dependencies. Nodes with 0 dependencies are at level 0.
2. **Serializing Cycles**: The runner enforces concurrency *between* pools, but serial execution *within* a component that forms a cycle. Thus, if a Tarjan component contains multiple members, `buildParallelPools` creates a singleton pool (`[member]`) for each member individually.
3. **Chunking Singletons**: For components that only contain a single artifact, they are chunked together into arrays of size `parallel` (e.g., arrays of 5 IDs that can run concurrently).

The returned `string[][]` structure dictates exactly what the autonomous runner will claim: it will claim and finish all artifacts in `pools[0]` before moving to `pools[1]`.

---

## Invariants and Edge Cases

- **Deterministic**: The extraction and pool building are entirely pure functions. Given the same source code strings and artifact IDs, it will produce exactly the same parallel pools every time.
- **Fail-Safe Extraction**: Over-extracting dependencies (a false positive match) only harms concurrency by putting artifacts into later pools. Under-extracting (a false negative) risks breaking compilation. The regex approach is aggressively tuned to capture any word resembling a class name.
- **Single-Type Inheritance Refs**: When parsing Java `extends` and `implements`, generics (e.g., `List<MyModel>`) are stripped down by tokenizing on `<,>` to just resolve `MyModel`.

## Extension Points

- `extractSourceDependencies` can easily be extended with new `lang` branches to support C#, TypeScript, or Go without modifying the downstream pooling logic.
- The `aliases` map in `resolveQualifiedName` allows operators to inject manual resolution rules (e.g., aliasing `com.old.Name` to `com.new.Name`) before pool generation, bypassing regex limitations.
