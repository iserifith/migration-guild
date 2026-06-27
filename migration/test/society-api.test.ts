import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { addAcceptanceEvidence, recordArbitrationDecision } from "../registry/commands/evidence";
import { applySchema } from "../registry/db/schema";
import { startServer } from "../registry/commands/serve";
import { querySocietyReport } from "../guildctl/commands/society-report";
import type { SocietyReport, SocietyArtifactReport } from "../guildctl/commands/society-report";

test("GET /api/society matches society-report and includes artifact detail", async () => {
  const db = new Database(":memory:");
  applySchema(db);
  const id = "legacy-source:com.acme:Foo";
  registerArtifact(db, { id, kind: "legacy-source", path: "legacy/Foo.java", tier: "first-class" });
  setArtifactStatus(db, id, "migrated", { agent: "builder-agent", reason: "proposal" });
  db.prepare("INSERT INTO runs (agent, status, started_at) VALUES ('builder-agent', 'completed', datetime('now'))").run();
  const evidence = addAcceptanceEvidence(db, { artifactId: id, producedBy: "critic-agent", evidenceType: "test-command", command: "npm test", exitCode: 0, pass: 1, summary: "passed" });
  const decision = recordArbitrationDecision(db, { artifactId: id, arbiter: "arbiter-agent", decision: "approved", reason: "proof ok", evidenceIds: [evidence.evidence_id] });
  const expected = querySocietyReport(db);

  const server = startServer(db, 0);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const aggregate = await fetch(`http://127.0.0.1:${address.port}/api/society`).then((response) => response.json());
    assert.deepEqual(aggregate, expected);
    const detail = await fetch(`http://127.0.0.1:${address.port}/api/society?id=${encodeURIComponent(id)}`).then((response) => response.json()) as SocietyReport & { artifact: SocietyArtifactReport };
    assert.deepEqual({ ...detail, artifact: undefined }, { ...expected, artifact: undefined });
    assert.equal(detail.artifact.id, id);
    assert.deepEqual(detail.artifact.evidence, [evidence]);
    assert.deepEqual(detail.artifact.arbitration, [decision]);
  } finally {
    server.close();
    db.close();
  }
});
