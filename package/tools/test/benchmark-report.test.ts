import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact } from "../registry/commands/artifacts";
import { compareBenchmarkRuns, recordBenchmarkRun } from "../registry/commands/benchmark";
import { applySchema } from "../registry/db/schema";

const ARTIFACT_ID = "legacy-source:com.acme:Foo";
function db() { const d = new Database(":memory:"); applySchema(d); return d; }

test("schema creates benchmark_runs", () => { const d=db(); try { const row=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='benchmark_runs'").get() as {name:string}|undefined; assert.equal(row?.name, "benchmark_runs"); } finally { d.close(); } });

test("record validates mode verdict and rate", () => { const d=db(); try {
  assert.throws(() => recordBenchmarkRun(d, { mode: "bad" as never, fixture: "f", elapsedMs: 1, totalRuns: 1, failedRuns: 0, artifactsPlanned: 1, artifactsCompleted: 1, evidencePassRate: 1, reworkCount: 0, verdict: "pass" }));
  assert.throws(() => recordBenchmarkRun(d, { mode: "guild", fixture: "f", elapsedMs: 1, totalRuns: 1, failedRuns: 0, artifactsPlanned: 1, artifactsCompleted: 1, evidencePassRate: 2, reworkCount: 0, verdict: "pass" }));
} finally { d.close(); } });

test("compare rejects wrong modes and returns deltas", () => { const d=db(); try {
  const b=recordBenchmarkRun(d, { mode: "single-agent", fixture: "f", elapsedMs: 1000, totalRuns: 3, failedRuns: 1, artifactsPlanned: 2, artifactsCompleted: 1, evidencePassRate: 0.5, reworkCount: 2, verdict: "fail", totalCostUsd: 1 });
  const g=recordBenchmarkRun(d, { mode: "guild", fixture: "f", elapsedMs: 800, totalRuns: 4, failedRuns: 0, artifactsPlanned: 2, artifactsCompleted: 2, evidencePassRate: 1, reworkCount: 0, verdict: "pass", totalCostUsd: 2 });
  const c=compareBenchmarkRuns(d, b.benchmark_id, g.benchmark_id);
  assert.equal(c.deltas.elapsed_ms, -200);
  assert.equal(c.deltas.failed_runs, -1);
  assert.equal(c.deltas.completion_rate, 0.5);
  assert.throws(() => compareBenchmarkRuns(d, g.benchmark_id, b.benchmark_id));
} finally { d.close(); } });

function fixture() { const cwd=path.resolve(__dirname,".."); const dir=mkdtempSync(path.join(tmpdir(),"guildctl-benchmark-")); const dbPath=path.join(dir,"registry.db"); const d=new Database(dbPath); applySchema(d); registerArtifact(d,{id:ARTIFACT_ID,kind:"legacy-source",path:"legacy/src/main/java/com/acme/Foo.java",tier:"first-class"}); d.close(); return {cwd,dir,dbPath,scriptPath:path.join(cwd,"guildctl","cli.ts")}; }
function run(fx: ReturnType<typeof fixture>, args: string[]) { return spawnSync(process.execPath,["--import","tsx",fx.scriptPath,"--db",fx.dbPath,...args],{cwd:fx.cwd,encoding:"utf8"}); }

test("benchmark CLI record/report/compare JSON is parseable", () => { const fx=fixture(); try {
  const a=["benchmark","record","--mode","single-agent","--fixture","demo","--elapsed-ms","1000","--total-runs","1","--failed-runs","1","--artifacts-planned","1","--artifacts-completed","0","--evidence-pass-rate","0","--rework-count","1","--verdict","fail","--json"];
  const b=["benchmark","record","--mode","guild","--fixture","demo","--elapsed-ms","700","--total-runs","3","--failed-runs","0","--artifacts-planned","1","--artifacts-completed","1","--evidence-pass-rate","1","--rework-count","0","--verdict","pass","--json"];
  const ra=run(fx,a); assert.equal(ra.status,0,ra.stderr); const ba=JSON.parse(ra.stdout);
  const rb=run(fx,b); assert.equal(rb.status,0,rb.stderr); const gb=JSON.parse(rb.stdout);
  const rr=run(fx,["benchmark","report","--json"]); assert.equal(rr.status,0,rr.stderr); assert.equal(JSON.parse(rr.stdout).length,2);
  const rc=run(fx,["benchmark","compare","--baseline",ba.benchmark_id,"--guild",gb.benchmark_id,"--json"]); assert.equal(rc.status,0,rc.stderr); assert.equal(JSON.parse(rc.stdout).deltas.failed_runs,-1);
} finally { rmSync(fx.dir,{recursive:true,force:true}); } });
