import type Database from "better-sqlite3";

// ─── TASK-10: source-level dependency extraction + dependency-aware pooling ───
//
// These functions are pure and deterministic so they can be unit-tested without
// an LLM. Extraction is regex-level (import / extends / implements), which is the
// agreed bar — the conservative direction is *extra* links, which only costs
// parallelism, never correctness.

export type SourceLang = "java" | "python" | "other";

export interface SourceDep {
  dependentId: string;
  dependencyId: string;
  signal: "import" | "inheritance";
}

// Resolve a fully-qualified class name (Java) or module path (Python) to a
// registered artifact id, if one exists in the registry id set.
function resolveJavaFqcn(fqcn: string, ids: Set<string>): string | null {
  // fqcn like com.acme.SubscriptionEntry → candidate ids use the last segment
  // as the class name (legacy-source:<module>:<ClassName>). Try exact and
  // suffix matches against the registered id set.
  const simple = fqcn.split(".").pop()!;
  if (ids.has(`legacy-source:${simple}`)) return `legacy-source:${simple}`;
  for (const id of ids) {
    if (id.endsWith(`:${simple}`)) return id;
  }
  return null;
}

function resolvePythonModule(mod: string, ids: Set<string>): string | null {
  const simple = mod.split(".").pop()!;
  if (ids.has(`legacy-source:${simple}`)) return `legacy-source:${simple}`;
  for (const id of ids) {
    if (id.endsWith(`:${simple}`)) return id;
  }
  return null;
}

// Extract dependency links from a single source file's text.
export function extractSourceDependencies(
  dependentId: string,
  content: string,
  lang: SourceLang,
  ids: Set<string>,
): SourceDep[] {
  const out: SourceDep[] = [];
  const seen = new Set<string>();

  const push = (dependencyId: string | null, signal: "import" | "inheritance") => {
    if (!dependencyId) return;
    if (dependencyId === dependentId) return;
    const key = `${dependencyId}:${signal}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ dependentId, dependencyId, signal });
  };

  if (lang === "java") {
    for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
      push(resolveJavaFqcn(m[1], ids), "import");
    }
    // extends / implements of a registered type (single-type refs; generics handled
    // by stripping the first type argument only when it is a plain identifier).
    for (const m of content.matchAll(/(?:extends|implements)\s+([\w.<>, ]+?)\s*(?:\{|$)/gm)) {
      for (const token of m[1].split(/[<>, ]+/)) {
        const name = token.trim();
        if (name.length === 0) continue;
        push(resolveJavaFqcn(name, ids), "inheritance");
      }
    }
  } else if (lang === "python") {
    for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(?:[\w.* ]+)/gm)) {
      push(resolvePythonModule(m[1], ids), "import");
    }
    for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) {
      push(resolvePythonModule(m[1], ids), "import");
    }
  }

  return out;
}

// Persist auto-extracted links for one artifact, replacing prior auto links but
// preserving manually-added ones.
export function recordAutoDependencies(
  db: Database.Database,
  dependentId: string,
  deps: SourceDep[],
): void {
  const tx = db.transaction(() => {
    db.prepare(
      "DELETE FROM source_dependencies WHERE dependent_id = ? AND created_by = 'auto'",
    ).run(dependentId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO source_dependencies (dependent_id, dependency_id, signal, created_by) VALUES (?, ?, ?, 'auto')",
    );
    for (const d of deps) ins.run(d.dependentId, d.dependencyId, d.signal);
  });
  tx();
}

export function addManualDependency(
  db: Database.Database,
  dependentId: string,
  dependencyId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO source_dependencies (dependent_id, dependency_id, signal, created_by) VALUES (?, ?, 'manual', 'manual')",
  ).run(dependentId, dependencyId);
}

export function removeDependency(
  db: Database.Database,
  dependentId: string,
  dependencyId: string,
): void {
  db.prepare(
    "DELETE FROM source_dependencies WHERE dependent_id = ? AND dependency_id = ?",
  ).run(dependentId, dependencyId);
}

export function listDependencies(
  db: Database.Database,
  dependentId?: string,
): Array<{ dependentId: string; dependencyId: string; signal: string; createdBy: string }> {
  if (dependentId) {
    return db
      .prepare(
        "SELECT dependent_id AS dependentId, dependency_id AS dependencyId, signal, created_by AS createdBy FROM source_dependencies WHERE dependent_id = ? ORDER BY dependency_id",
      )
      .all(dependentId) as Array<{ dependentId: string; dependencyId: string; signal: string; createdBy: string }>;
  }
  return db
    .prepare(
      "SELECT dependent_id AS dependentId, dependency_id AS dependencyId, signal, created_by AS createdBy FROM source_dependencies ORDER BY dependent_id, dependency_id",
    )
    .all() as Array<{ dependentId: string; dependencyId: string; signal: string; createdBy: string }>;
}

// Strongly-connected components (Tarjan) — collapses cycles so cycle members are
// serialized together for pool safety.
export function collapseSCC(nodes: string[], edges: Array<[string, string]>): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const [a, b] of edges) {
    if (adj.has(a) && adj.has(b)) adj.get(a)!.push(b);
  }
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const components: string[][] = [];

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

  for (const n of nodes) if (!idx.has(n)) strongconnect(n);
  return components;
}

// Build parallel pools from the source-dependency graph. No artifact shares a
// pool with anything it depends on or that depends on it (direct link). Pools are
// returned in level order; a pool may only start after its predecessor levels
// have completed, which the runner enforces by draining pools serially.
export function buildParallelPools(
  db: Database.Database,
  parallel: number,
): string[][] {
  const parallelN = Math.max(1, parallel);
  const ids = (
    db.prepare("SELECT id FROM artifacts WHERE tier = 'first-class'").all() as Array<{ id: string }>
  ).map((r) => r.id);

  const idSet = new Set(ids);
  const rows = db
    .prepare("SELECT dependent_id, dependency_id FROM source_dependencies")
    .all() as Array<{ dependent_id: string; dependency_id: string }>;
  const edges: Array<[string, string]> = [];
  for (const r of rows) {
    if (idSet.has(r.dependent_id) && idSet.has(r.dependency_id)) {
      edges.push([r.dependent_id, r.dependency_id]);
    }
  }

  // Collapse cycles first: mutual imports are common in legacy Java, and a
  // longest-path walk over a cyclic graph never terminates. Each strongly-
  // connected component becomes one serialization unit in a condensed DAG.
  const comps = collapseSCC(ids, edges);
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => c.forEach((n) => compOf.set(n, i)));

  const compDeps = new Map<number, Set<number>>();
  comps.forEach((_, i) => compDeps.set(i, new Set()));
  for (const [dependent, dependency] of edges) {
    const a = compOf.get(dependent)!;
    const b = compOf.get(dependency)!;
    if (a !== b) compDeps.get(a)!.add(b);
  }

  // Topological level assignment via longest-path layering over the DAG.
  const level = new Map<number, number>();
  const visit = (c: number): number => {
    if (level.has(c)) return level.get(c)!;
    let lvl = 0;
    for (const d of compDeps.get(c)!) lvl = Math.max(lvl, visit(d) + 1);
    level.set(c, lvl);
    return lvl;
  };
  for (let i = 0; i < comps.length; i++) visit(i);

  // Emit pools level by level. Same-level components never link to each other
  // (a link forces a higher level), so singleton components at one level can
  // share pools. Cycle members must run serially relative to each other, so
  // each member of a multi-node component becomes its own singleton pool.
  const pools: string[][] = [];
  const maxLevel = comps.length > 0 ? Math.max(...level.values()) : -1;
  for (let l = 0; l <= maxLevel; l++) {
    const singles: string[] = [];
    for (let i = 0; i < comps.length; i++) {
      if (level.get(i) !== l) continue;
      if (comps[i].length === 1) singles.push(comps[i][0]);
      else for (const member of comps[i]) pools.push([member]);
    }
    for (let i = 0; i < singles.length; i += parallelN) {
      pools.push(singles.slice(i, i + parallelN));
    }
  }
  return pools;
}

// Detect cycles in the source-dependency graph; returns each cycle as a list of
// dependent → dependency edges.
export function findCycles(
  db: Database.Database,
): Array<{ members: string[]; edges: Array<[string, string]> }> {
  const ids = (
    db.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>
  ).map((r) => r.id);
  const edges = (
    db.prepare("SELECT dependent_id, dependency_id FROM source_dependencies").all() as Array<{
      dependent_id: string;
      dependency_id: string;
    }>
  ).map((r) => [r.dependent_id, r.dependency_id] as [string, string]);
  const components = collapseSCC(ids, edges).filter((c) => c.length > 1);
  const result: Array<{ members: string[]; edges: Array<[string, string]> }> = [];
  for (const comp of components) {
    const set = new Set(comp);
    result.push({
      members: comp,
      edges: edges.filter(([a, b]) => set.has(a) && set.has(b)),
    });
  }
  return result;
}
