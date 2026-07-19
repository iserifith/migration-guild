import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applySchema } from "../registry/db/schema";
import { startRun, finishRun } from "../registry/commands/runs";
import { startServer } from "../registry/commands/serve";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fetchUrl(port: number, urlPath: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body,
          contentType: res.headers["content-type"] ?? "",
        });
      });
    });
    req.on("error", () => resolve({ status: 0, body: "", contentType: "" }));
  });
}

test("GET /api/runs/<id>/log returns the log file as text/plain", async () => {
  const db = createDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-log-test-"));
  const logPath = path.join(tmpDir, "test.log");
  fs.writeFileSync(logPath, "line 1\nline 2\nline 3\n");

  try {
    const runId = "run-log-1";
    startRun(db, { runId, agent: "test-agent", phase: "test", logFile: logPath });

    const port = 4321 + Math.floor(Math.random() * 1000);
    const server = startServer(db, port);
    await new Promise((r) => setTimeout(r, 100));

    const result = await fetchUrl(port, `/api/runs/${encodeURIComponent(runId)}/log`);

    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/plain/);
    assert.equal(result.body, "line 1\nline 2\nline 3\n");

    server.close();
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/runs/<id>/log returns 404 for missing run", async () => {
  const db = createDb();

  try {
    const port = 4321 + Math.floor(Math.random() * 1000);
    const server = startServer(db, port);
    await new Promise((r) => setTimeout(r, 100));

    const result = await fetchUrl(port, "/api/runs/nonexistent-run/log");

    assert.equal(result.status, 404);
    assert.match(result.body, /Run not found/);

    server.close();
  } finally {
    db.close();
  }
});

test("GET /api/runs/<id>/log returns 404 when log file is missing on disk", async () => {
  const db = createDb();

  try {
    const runId = "run-log-missing-file";
    startRun(db, { runId, agent: "test-agent", phase: "test", logFile: "/nonexistent/path.log" });

    const port = 4321 + Math.floor(Math.random() * 1000);
    const server = startServer(db, port);
    await new Promise((r) => setTimeout(r, 100));

    const result = await fetchUrl(port, `/api/runs/${encodeURIComponent(runId)}/log`);

    assert.equal(result.status, 404);
    assert.match(result.body, /Log file not found/);

    server.close();
  } finally {
    db.close();
  }
});