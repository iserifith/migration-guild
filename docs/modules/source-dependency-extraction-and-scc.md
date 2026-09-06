# Source Dependency Extraction & SCC Deep-Dive

## Overview

The migration-guild platform processes large sets of legacy artifacts by executing transformations in parallel pools. However, running transformations concurrently requires a deep understanding of the dependencies between modules to avoid race conditions and ensure correct compilation/evaluation order.

The subsystem responsible for this logic resides in `migration/registry/commands/sourceDeps.ts`. It performs two critical functions:
1. **Source-level dependency extraction:** Parsing legacy source code to determine what depends on what.
2. **Dependency-aware parallel pooling:** Organizing artifacts into a safe execution order by evaluating the resulting dependency graph and collapsing cycles.

This document details the actual mechanisms of how dependencies are extracted from raw legacy code and how Tarjan's Strongly Connected Components (SCC) algorithm is used to safely handle circular dependencies.

---

## 1. Source-Level Dependency Extraction

When dealing with legacy codebases (especially during the initial stages of a migration), the code often cannot compile. Relying on advanced AST parsers or compiler APIs to extract dependencies is brittle—if the syntax is invalid or dependencies are missing, an AST parser might fail completely.

To solve this, the pipeline uses deterministic, regex-based parsing to extract dependencies directly from the source text.

### Mechanism (`extractSourceDependencies`)

The `extractSourceDependencies` function (`migration/registry/commands/sourceDeps.ts:extractSourceDependencies`) evaluates a file's content based on its language (`java` or `python`):

- **Java:** It uses regular expressions to find `import` statements (e.g., `import static com.example.MyClass;`) and inheritance declarations (`extends` and `implements`). Generics are handled by stripping type arguments so that only the raw identifier is evaluated.
- **Python:** It looks for `from ... import ...` and plain `import ...` statements.

```typescript
// Excerpt from migration/registry/commands/sourceDeps.ts:extractSourceDependencies
if (lang === "java") {
  for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
    push(resolveJavaFqcn(m[1], ids, aliases), "import");
  }
  for (const m of content.matchAll(/(?:extends|implements)\s+([\w.<>, ]+?)\s*(?:\{|$)/gm)) {
    for (const token of m[1].split(/[<>, ]+/)) {
      const name = token.trim();
      if (name.length === 0) continue;
      push(resolveJavaFqcn(name, ids, aliases), "inheritance");
    }
  }
}
```

### Identifier Resolution

Once raw strings like `com.example.MyClass` are extracted, they must be mapped to actual artifact IDs in the registry. This is handled by `resolveQualifiedName`.

The resolver attempts to match the extracted string against a known set of IDs and aliases. If a match is unambiguous (e.g., the set of matched `legacy-source:` artifacts resolves to exactly one ID), the dependency link is created. If the match is ambiguous (multiple possible resolutions) or cannot be found, it evaluates to `null` and is skipped.

The strategy intentionally errs on the side of caution: it is better to extract an extra link (which only reduces parallelism) than to miss a crucial dependency (which causes correctness issues).

---

## 2. Dependency Graph and Circular Dependencies (SCC)

Once dependencies are extracted, they form a directed graph where nodes are artifacts and edges are dependency links.

A common issue in legacy Java codebases is the presence of **mutual imports** (e.g., Class A imports Class B, and Class B imports Class A). This creates a cycle in the dependency graph. If the runner attempts a longest-path walk over a graph with cycles to determine execution order, the algorithm will infinitely loop.

### Tarjan's Algorithm (`collapseSCC`)

To solve this, the graph must be transformed into a Directed Acyclic Graph (DAG). The pipeline achieves this by finding all Strongly Connected Components (SCCs)—clusters of nodes where every node can reach every other node in the cluster (i.e., they are in a cycle).

This is implemented using **Tarjan's Strongly Connected Components algorithm** in `migration/registry/commands/sourceDeps.ts:collapseSCC`.

The algorithm performs a depth-first search, keeping track of the "discovery index" (`idx`) and the "lowest reachable index" (`low`) for each node. When a node's `low` value equals its `idx`, it means a complete cycle has been found, and the nodes on the current search stack are popped off to form a component.

```typescript
// Excerpt from migration/registry/commands/sourceDeps.ts:collapseSCC
const strongconnect = (v: string) => {
  idx.set(v, index);
  low.set(v, index);
  index++;
  stack.push(v);
  onStack.add(v);
  for (const w of adj.get(v)!) {
    if (!idx.has(w)) {
      strongconnect(w);
      low.set(v, Math.min(low.get(v)!, low.get(w)!));
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
  }
  if (low.get(v) === idx.get(v)) {
    const comp: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      comp.push(w);
    } while (w !== v);
    components.push(comp);
  }
};
```

By collapsing these cycles, each strongly connected component becomes a single serialization unit in a condensed DAG.

---

## 3. Parallel Pool Generation

With the cycles collapsed, the pipeline can safely generate execution pools using `buildParallelPools`.

### Topological Level Assignment

The function assigns a topological level to each component by doing a longest-path walk over the now-acyclic DAG:
1. Components with no dependencies are placed at level 0.
2. Components that depend on level 0 components are placed at level 1, and so on.

```typescript
// Excerpt from migration/registry/commands/sourceDeps.ts:buildParallelPools
const level = new Map<number, number>();
const visit = (c: number): number => {
  if (level.has(c)) return level.get(c)!;
  let lvl = 0;
  for (const d of compDeps.get(c)!) lvl = Math.max(lvl, visit(d) + 1);
  level.set(c, lvl);
  return lvl;
};
```

### Emitting the Pools

Finally, the pools are emitted level-by-level. The runner enforces that a pool may only start after all predecessor levels have completed.

- **Independent Modules (Singletons):** Modules at the same level that do not link to each other can be placed in the same pool up to the `parallel` concurrency limit.
- **Cycles (Multi-node Components):** Members of a cycle (a multi-node component discovered by Tarjan's algorithm) must be executed serially relative to each other to avoid race conditions. Therefore, each member of a multi-node component is emitted as its own singleton pool, forcing the runner to drain them sequentially.

## Summary Invariants

1. **Deterministic Parsing:** Dependency extraction uses static regexes, not ASTs, prioritizing legacy code safety over deep syntactic correctness.
2. **Fail-Closed Resolution:** Unambiguous matches result in links. Ambiguous matches evaluate to null. Over-linking reduces parallelism, but under-linking causes build failure.
3. **Cycle Collapsing:** Tarjan's SCC algorithm condenses cyclic dependencies into single components to guarantee DAG properties for topological sorting.
4. **Serial Execution for Cycles:** Nodes within a detected cycle are never executed in parallel; they are assigned to singleton pools to ensure sequential execution.
