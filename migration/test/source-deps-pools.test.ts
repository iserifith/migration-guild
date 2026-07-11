import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  extractSourceDependencies,
  recordAutoDependencies,
  addManualDependency,
  removeDependency,
  listDependencies,
  collapseSCC,
  buildParallelPools,
  findCycles,
} from "../registry/commands/sourceDeps";
import { registerArtifact } from "../registry/commands/artifacts";
import { scanAndRegister } from "../guildctl/commands/inventory";
import { applySchema } from "../registry/db/schema";

const REGISTRY_CLI = path.resolve(__dirname, "../registry/cli.ts");
const PROJECT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function register(db: Database.Database, id: string, filePath?: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: filePath ?? `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
}

// The field case from the collision run: Subscription imports SubscriptionEntry,
// PlanetGroup extends a registered base, Category is standalone.
function seedFieldCase(db: Database.Database): void {
  for (const cls of ["Subscription", "SubscriptionEntry", "Category", "PlanetGroup", "BasePlanet"]) {
    register(db, `legacy-source:com.acme:${cls}`);
  }
  const subscription = [
    "package com.acme;",
    "import com.acme.SubscriptionEntry;",
    "import java.util.List;",
    "public class Subscription { private List<SubscriptionEntry> entries; }",
  ].join("\n");
  const planetGroup = [
    "package com.acme;",
    "public class PlanetGroup extends BasePlanet implements java.io.Serializable {",
    "}",
  ].join("\n");
  const category = ["package com.acme;", "public class Category { }"].join("\n");

  const ids = new Set(
    (db.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>).map((r) => r.id),
  );
  recordAutoDependencies(
    db,
    "legacy-source:com.acme:Subscription",
    extractSourceDependencies("legacy-source:com.acme:Subscription", subscription, "java", ids),
  );
  recordAutoDependencies(
    db,
    "legacy-source:com.acme:PlanetGroup",
    extractSourceDependencies("legacy-source:com.acme:PlanetGroup", planetGroup, "java", ids),
  );
  recordAutoDependencies(
    db,
    "legacy-source:com.acme:Category",
    extractSourceDependencies("legacy-source:com.acme:Category", category, "java", ids),
  );
}

test("TASK-10: Java fixture — import + inheritance links auto-created; standalone unlinked", () => {
  const db = createDb();
  seedFieldCase(db);

  const subDeps = listDependencies(db, "legacy-source:com.acme:Subscription");
  assert.deepEqual(
    subDeps.map((d) => [d.dependencyId, d.signal]),
    [["legacy-source:com.acme:SubscriptionEntry", "import"]],
  );

  const pgDeps = listDependencies(db, "legacy-source:com.acme:PlanetGroup");
  assert.deepEqual(
    pgDeps.map((d) => [d.dependencyId, d.signal]),
    [["legacy-source:com.acme:BasePlanet", "inheritance"]],
  );

  assert.deepEqual(listDependencies(db, "legacy-source:com.acme:Category"), []);
  db.close();
});

test("TASK-10: unresolvable imports (JDK, third-party) produce no links", () => {
  const db = createDb();
  register(db, "legacy-source:com.acme:Only");
  const ids = new Set(["legacy-source:com.acme:Only"]);
  const content = [
    "package com.acme;",
    "import java.util.Map;",
    "import org.hibernate.Session;",
    "public class Only extends Thread { }",
  ].join("\n");
  const deps = extractSourceDependencies("legacy-source:com.acme:Only", content, "java", ids);
  assert.deepEqual(deps, []);
  db.close();
});

test("TASK-10: Python fixture — `from a import b` produces the link", () => {
  const db = createDb();
  register(db, "legacy-source:app:util", "legacy/app/util.py");
  register(db, "legacy-source:app:handlers", "legacy/app/handlers.py");
  const ids = new Set(["legacy-source:app:util", "legacy-source:app:handlers"]);
  const content = ["from util import helper", "import os", "", "def handle():", "    pass"].join("\n");
  const deps = extractSourceDependencies("legacy-source:app:handlers", content, "python", ids);
  assert.deepEqual(
    deps.map((d) => [d.dependencyId, d.signal]),
    [["legacy-source:app:util", "import"]],
  );
  recordAutoDependencies(db, "legacy-source:app:handlers", deps);
  assert.equal(listDependencies(db, "legacy-source:app:handlers").length, 1);
  db.close();
});

test("TASK-10: manual `deps add` survives auto re-run; auto links are refreshed", () => {
  const db = createDb();
  for (const cls of ["A", "X", "Y", "M"]) register(db, `legacy-source:com.acme:${cls}`);
  const A = "legacy-source:com.acme:A";

  addManualDependency(db, A, "legacy-source:com.acme:M");
  recordAutoDependencies(db, A, [
    { dependentId: A, dependencyId: "legacy-source:com.acme:X", signal: "import" },
  ]);

  // Re-run: auto rows replaced (X gone, Y in), manual row preserved.
  recordAutoDependencies(db, A, [
    { dependentId: A, dependencyId: "legacy-source:com.acme:Y", signal: "import" },
  ]);

  const rows = listDependencies(db, A);
  const byId = new Map(rows.map((r) => [r.dependencyId, r.createdBy]));
  assert.equal(byId.get("legacy-source:com.acme:M"), "manual", "manual link survives");
  assert.equal(byId.get("legacy-source:com.acme:Y"), "auto", "new auto link present");
  assert.ok(!byId.has("legacy-source:com.acme:X"), "stale auto link refreshed away");

  removeDependency(db, A, "legacy-source:com.acme:M");
  assert.ok(!listDependencies(db, A).some((r) => r.dependencyId.endsWith(":M")));
  db.close();
});

test("TASK-10: collapseSCC groups cycle members and leaves the DAG part alone", () => {
  const comps = collapseSCC(
    ["A", "B", "C"],
    [
      ["A", "B"],
      ["B", "A"],
      ["C", "A"],
    ],
  );
  const cycle = comps.find((c) => c.length > 1);
  assert.ok(cycle, "A/B cycle collapsed into one component");
  assert.deepEqual([...cycle!].sort(), ["A", "B"]);
  assert.ok(comps.some((c) => c.length === 1 && c[0] === "C"));
});

test("TASK-10: A→B→A cycle — findCycles reports it and pool building still completes, serialized", () => {
  const db = createDb();
  register(db, "legacy-source:com.acme:A");
  register(db, "legacy-source:com.acme:B");
  recordAutoDependencies(db, "legacy-source:com.acme:A", [
    { dependentId: "legacy-source:com.acme:A", dependencyId: "legacy-source:com.acme:B", signal: "import" },
  ]);
  recordAutoDependencies(db, "legacy-source:com.acme:B", [
    { dependentId: "legacy-source:com.acme:B", dependencyId: "legacy-source:com.acme:A", signal: "import" },
  ]);

  const cycles = findCycles(db);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0].members].sort(), [
    "legacy-source:com.acme:A",
    "legacy-source:com.acme:B",
  ]);

  // This must terminate (regression: longest-path layering over a cyclic graph
  // recursed forever) and must serialize the cycle members.
  const pools = buildParallelPools(db, 4);
  const flat = pools.flat();
  assert.deepEqual([...flat].sort(), ["legacy-source:com.acme:A", "legacy-source:com.acme:B"]);
  for (const pool of pools) {
    assert.equal(pool.length, 1, "cycle members run serially — singleton pools only");
  }
  db.close();
});

test("TASK-10: pool builder never co-pools linked artifacts (parallel 4), dependencies drain first", () => {
  const db = createDb();
  seedFieldCase(db);
  // Extra standalone artifacts so a level actually has to chunk at parallel 4.
  for (const cls of ["S1", "S2", "S3", "S4", "S5"]) register(db, `legacy-source:com.acme:${cls}`);

  const pools = buildParallelPools(db, 4);

  // Every artifact appears exactly once.
  const flat = pools.flat();
  assert.equal(flat.length, new Set(flat).size, "no artifact appears twice");
  assert.equal(flat.length, 10, "all first-class artifacts pooled");

  // No pool contains a linked pair (either direction).
  const links = listDependencies(db).map((r) => [r.dependentId, r.dependencyId] as [string, string]);
  for (const pool of pools) {
    const set = new Set(pool);
    for (const [a, b] of links) {
      assert.ok(!(set.has(a) && set.has(b)), `linked pair ${a} ↔ ${b} share a pool`);
    }
    assert.ok(pool.length <= 4, "pool respects the parallel bound");
  }

  // Level order: a dependency's pool comes strictly before its dependent's pool.
  const poolIndex = new Map<string, number>();
  pools.forEach((pool, i) => pool.forEach((id) => poolIndex.set(id, i)));
  for (const [dependent, dependency] of links) {
    assert.ok(
      poolIndex.get(dependency)! < poolIndex.get(dependent)!,
      `${dependency} must drain before ${dependent}`,
    );
  }
  db.close();
});

test("TASK-10: end-to-end inventory — links auto-created; test-file imports produce no links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-deps-e2e-"));
  const db = createDb();
  try {
    fs.cpSync(path.join(REPO_ROOT, "stacks"), path.join(root, "stacks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
    fs.writeFileSync(path.join(root, ".guild", "config.yaml"), "version: 1\nstack: java-spring\n");

    const write = (rel: string, content: string) => {
      const file = path.join(root, "legacy", ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    };
    write(
      "app/src/main/java/com/acme/Subscription.java",
      "package com.acme;\nimport com.acme.SubscriptionEntry;\npublic class Subscription { }\n",
    );
    write(
      "app/src/main/java/com/acme/SubscriptionEntry.java",
      "package com.acme;\npublic class SubscriptionEntry { }\n",
    );
    write(
      "app/src/test/java/com/acme/SubscriptionTest.java",
      "package com.acme;\nimport com.acme.Subscription;\npublic class SubscriptionTest { }\n",
    );

    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
      chunks.push(chunk.toString());
      return true;
    };
    try {
      scanAndRegister(db, root);
    } finally {
      (process.stdout.write as unknown) = orig;
    }
    const out = chunks.join("");
    assert.match(out, /source-level links auto-detected: 1/);

    const rows = listDependencies(db);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].dependentId.endsWith(":Subscription"));
    assert.ok(rows[0].dependencyId.endsWith(":SubscriptionEntry"));
    // The test file was registered as an artifact but produced no outgoing links.
    assert.ok(!rows.some((r) => r.dependentId.endsWith(":SubscriptionTest")));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("TASK-10: deps CLI — add/list/validate round-trip via spawned registry CLI", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guild-deps-cli-"));
  const dbPath = path.join(tmp, "registry.db");
  const seed = new Database(dbPath);
  applySchema(seed);
  register(seed, "legacy-source:com.acme:A");
  register(seed, "legacy-source:com.acme:B");
  seed.close();

  const env = { ...process.env, REGISTRY_DB: dbPath };
  const cliPrefix = ["--import", "tsx", REGISTRY_CLI];
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [...cliPrefix, "deps", ...args], { cwd: PROJECT_ROOT, env, encoding: "utf8" });

  const add = cli("add", "legacy-source:com.acme:A", "legacy-source:com.acme:B");
  assert.equal(add.status, 0, add.stderr);

  const list = cli("list");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /legacy-source:com\.acme:A/);
  assert.match(list.stdout, /legacy-source:com\.acme:B/);
  assert.match(list.stdout, /manual/);

  const clean = cli("validate");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /"cycles_detected":\s*0/);

  const back = cli("add", "legacy-source:com.acme:B", "legacy-source:com.acme:A");
  assert.equal(back.status, 0, back.stderr);
  const cyclic = cli("validate");
  assert.equal(cyclic.status, 0, cyclic.stderr);
  assert.match(cyclic.stdout, /"cycles_detected":\s*1/);

  fs.rmSync(tmp, { recursive: true, force: true });
});
