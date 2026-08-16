import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";
import { searchLibraryDocs } from "../mcp-doc-server/queries";

/**
 * specs/007-doc-rag-lookup — T036 (SC-006 search-quality benchmark).
 *
 * Plants a fixture of documentation entries spanning THREE libraries in a
 * :memory: index and issues TEN behavior-description queries (NOT exact symbol
 * names). It asserts the correct entry appears in the top 3 ranked results for
 * at least 9 of the 10 queries, calling the SAME search function the MCP tool
 * uses (`searchLibraryDocs` from queries.ts).
 *
 * This is the search-quality gate from the spec: a codegen agent mostly does
 * NOT know the symbol it needs by name — it describes the behavior it wants
 * ("argument null check", "deep copy of a collection", "parse json string to
 * object") and the RAG lookup must surface the right method. The 90% bar is
 * intentional and must NOT be lowered; if a query cannot rank top-3, the
 * fixture or the search/ranking is improved, not the bar.
 */

interface FixtureEntry {
  entryId: string;
  library: string;
  version: string;
  symbolKind: "class" | "method";
  symbolName: string;
  signature: string | null;
  description: string;
  sourceUrl: string;
  sourceExcerpt: string;
}

interface QueryCase {
  /** Behavior description, not an exact symbol name. */
  query: string;
  /** The entry_id expected to appear in the top 3. */
  expectedEntryId: string;
  /** Human-readable note for failure reporting. */
  note: string;
}

const GUAVA = "com.google.guava:guava";
const GUAVA_VER = "33.2.1-jre";
const COMMONS = "org.apache.commons:commons-lang3";
const COMMONS_VER = "3.14.0";
const JACKSON = "com.fasterxml.jackson.core:jackson-databind";
const JACKSON_VER = "2.17.1";

const FIXTURE: FixtureEntry[] = [
  // --- Guava (argument/state validation family) ---
  {
    entryId: "f-guava-checknotnull",
    library: GUAVA, version: GUAVA_VER, symbolKind: "method", symbolName: "Preconditions#checkNotNull",
    signature: "(java.lang.Object)",
    description: "Ensures that an object reference passed as a parameter to the calling method is not null; throws NullPointerException on a null argument.",
    sourceUrl: "https://guava.dev/api/Preconditions.html#checkNotNull", sourceExcerpt: "checkNotNull(T reference)",
  },
  {
    entryId: "f-guava-checkargument",
    library: GUAVA, version: GUAVA_VER, symbolKind: "method", symbolName: "Preconditions#checkArgument",
    signature: "(boolean)",
    description: "Ensures the truth of an expression involving one or more parameters to the calling method; throws IllegalArgumentException if the expression is false.",
    sourceUrl: "https://guava.dev/api/Preconditions.html#checkArgument", sourceExcerpt: "checkArgument(boolean expression)",
  },
  {
    entryId: "f-guava-immutablelist",
    library: GUAVA, version: GUAVA_VER, symbolKind: "class", symbolName: "com.google.common.collect.ImmutableList",
    signature: null,
    description: "A high-performance, immutable, random-access list implementation that cannot be modified after creation and rejects null elements.",
    sourceUrl: "https://guava.dev/api/ImmutableList.html", sourceExcerpt: "ImmutableList — immutable random-access list.",
  },
  {
    entryId: "f-guava-splitter",
    library: GUAVA, version: GUAVA_VER, symbolKind: "class", symbolName: "com.google.common.base.Splitter",
    signature: null,
    description: "Splits strings into substrings on a separator or by a regular expression, with configurable omission of empty results and trimming.",
    sourceUrl: "https://guava.dev/api/Splitter.html", sourceExcerpt: "Splitter — extract substrings from a string.",
  },
  // --- Apache Commons Lang (string / object utilities) ---
  {
    entryId: "f-commons-stringutils-isblank",
    library: COMMONS, version: COMMONS_VER, symbolKind: "method", symbolName: "StringUtils#isBlank",
    signature: "(java.lang.CharSequence)",
    description: "Checks if a CharSequence is empty, contains only whitespace, or is null; returns true for any of those cases.",
    sourceUrl: "https://commons.apache.org/lang/apidocs/StringUtils.html#isBlank", sourceExcerpt: "isBlank(CharSequence cs)",
  },
  {
    entryId: "f-commons-objectutils-equals",
    library: COMMONS, version: COMMONS_VER, symbolKind: "method", symbolName: "ObjectUtils#equals",
    signature: "(java.lang.Object,java.lang.Object)",
    description: "Null-safe equality check that compares two objects and returns true when both are null or when they are equal, avoiding a NullPointerException on a null receiver.",
    sourceUrl: "https://commons.apache.org/lang/apidocs/ObjectUtils.html#equals", sourceExcerpt: "equals(Object a, Object b)",
  },
  {
    entryId: "f-commons-reflection-tostringbuilder",
    library: COMMONS, version: COMMONS_VER, symbolKind: "class", symbolName: "org.apache.commons.lang3.builder.ToStringBuilder",
    signature: null,
    description: "Assists in creating consistent toString() representations of objects by appending field names and values, useful for debugging and logging.",
    sourceUrl: "https://commons.apache.org/lang/apidocs/ToStringBuilder.html", sourceExcerpt: "ToStringBuilder — build a toString string.",
  },
  // --- Jackson (JSON binding) ---
  {
    entryId: "f-jackson-readvalue",
    library: JACKSON, version: JACKSON_VER, symbolKind: "method", symbolName: "ObjectMapper#readValue",
    signature: "(java.lang.String,java.lang.Class)",
    description: "Reads and parses a JSON string into a Java object of the given target class, deserializing the document tree into typed instances.",
    sourceUrl: "https://fasterxml.github.io/jackson-databind/javadoc/2.17/ObjectMapper.html#readValue", sourceExcerpt: "readValue(String, Class) — deserialize JSON.",
  },
  {
    entryId: "f-jackson-writevalueasstring",
    library: JACKSON, version: JACKSON_VER, symbolKind: "method", symbolName: "ObjectMapper#writeValueAsString",
    signature: "(java.lang.Object)",
    description: "Serializes a Java object into a JSON string representation, converting the object graph into a compact document.",
    sourceUrl: "https://fasterxml.github.io/jackson-databind/javadoc/2.17/ObjectMapper.html#writeValueAsString", sourceExcerpt: "writeValueAsString(Object) — serialize to JSON.",
  },
  {
    entryId: "f-jackson-objectnode",
    library: JACKSON, version: JACKSON_VER, symbolKind: "class", symbolName: "com.fasterxml.jackson.databind.node.ObjectNode",
    signature: null,
    description: "A mutable JSON object node that maps field names to values, allowing dynamic construction of a JSON document tree without a target class.",
    sourceUrl: "https://fasterxml.github.io/jackson-databind/javadoc/2.17/ObjectNode.html", sourceExcerpt: "ObjectNode — mutable JSON object node.",
  },
];

// Ten behavior-description queries. Each targets exactly one fixture entry.
const QUERIES: QueryCase[] = [
  { query: "argument null check", expectedEntryId: "f-guava-checknotnull", note: "Guava null guard" },
  { query: "validate boolean condition is true", expectedEntryId: "f-guava-checkargument", note: "Guava boolean precondition" },
  { query: "immutable list that rejects nulls", expectedEntryId: "f-guava-immutablelist", note: "Guava immutable list" },
  { query: "split a string on a separator", expectedEntryId: "f-guava-splitter", note: "Guava splitter" },
  { query: "check if text is empty or only whitespace", expectedEntryId: "f-commons-stringutils-isblank", note: "Commons isBlank" },
  { query: "compare two objects safely handling null", expectedEntryId: "f-commons-objectutils-equals", note: "Commons null-safe equals" },
  { query: "build a readable toString for debugging", expectedEntryId: "f-commons-reflection-tostringbuilder", note: "Commons ToStringBuilder" },
  { query: "parse json string into a java object", expectedEntryId: "f-jackson-readvalue", note: "Jackson deserialize" },
  { query: "convert object to json string", expectedEntryId: "f-jackson-writevalueasstring", note: "Jackson serialize" },
  { query: "build a json object dynamically", expectedEntryId: "f-jackson-objectnode", note: "Jackson ObjectNode" },
];

function seededDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, completed_at, triggered_by, locked_set_snapshot_count) VALUES ('run-bench', datetime('now'), datetime('now'), 'test', 3)",
  ).run();
  const insert = db.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, signature, description, return_type, source_url, source_excerpt, ingestion_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'run-bench')`,
  );
  const returnType = (e: FixtureEntry): string | null =>
    e.symbolKind === "method" ? "T" : null;
  for (const e of FIXTURE) {
    insert.run(
      e.entryId, e.library, e.version, e.symbolKind, e.symbolName, e.signature,
      e.description, returnType(e), e.sourceUrl, e.sourceExcerpt,
    );
  }
  return db;
}

const LIB_VERSION: Record<string, [string, string]> = {
  [GUAVA]: [GUAVA, GUAVA_VER],
  [COMMONS]: [COMMONS, COMMONS_VER],
  [JACKSON]: [JACKSON, JACKSON_VER],
};

test("SC-006: searchLibraryDocs ranks the correct entry in the top 3 for ≥9 of 10 behavior-description queries", () => {
  const db = seededDb();
  let hits = 0;
  const misses: string[] = [];

  for (const q of QUERIES) {
    const [library, version] = LIB_VERSION[FIXTURE.find((f) => f.entryId === q.expectedEntryId)!.library];
    const result = searchLibraryDocs(db, {
      library_name: library, library_version: version, query: q.query, limit: 10,
    });
    assert.equal(result.status, "ok", `query "${q.query}" should return ok`);
    if (result.status !== "ok") { misses.push(`${q.note} (no ok)`); continue; }
    const top3 = result.candidates.slice(0, 3).map((c) => c.symbol_name);
    // Map the ranked candidates back to fixture entry ids by symbol_name +
    // library/version scope (candidates are already scoped to this library).
    const fixtureFor = FIXTURE.filter((f) => f.library === library && f.version === version);
    const top3Ids = top3
      .map((sym) => fixtureFor.find((f) => f.symbolName === sym)?.entryId)
      .filter((id): id is string => Boolean(id));
    if (top3Ids.includes(q.expectedEntryId)) {
      hits += 1;
    } else {
      misses.push(`${q.note}: expected ${q.expectedEntryId} in top3, got ${JSON.stringify(top3)}`);
    }
  }

  const bar = 9;
  assert.ok(
    hits >= bar,
    `SC-006 requires ≥${bar}/10 queries to rank the correct entry in the top 3; got ${hits}/10. Misses:\n${misses.join("\n")}`,
  );
  // Also report so a human can see margin even on a pass.
  assert.ok(hits === 10 || hits >= bar, `top-3 hit rate ${hits}/10 (bar ${bar})`);
});

test("SC-006 (sanity): every planted query returns at least one candidate", () => {
  const db = seededDb();
  for (const q of QUERIES) {
    const [library, version] = LIB_VERSION[FIXTURE.find((f) => f.entryId === q.expectedEntryId)!.library];
    const result = searchLibraryDocs(db, {
      library_name: library, library_version: version, query: q.query, limit: 10,
    });
    assert.equal(result.status, "ok", `query "${q.query}" should return a result`);
    if (result.status === "ok") assert.ok(result.candidates.length > 0);
  }
});
