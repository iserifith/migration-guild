import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGuildConfig, scaffoldGuildConfig } from "../guildctl/config";
import { collectInitEvidence, createRunLedger, renderPrompt, scaffoldDefaultPrompts } from "../guildctl/workspace";

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-workspace-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, dependencies: { commander: "12.1.0" } }, null, 2));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};\n");
  return dir;
}

test("prompt pack scaffolds and renders init prompt with sanitized config", () => {
  const root = tempRepo();
  scaffoldGuildConfig(root);
  const cfg = resolveGuildConfig({ cwd: root });
  scaffoldDefaultPrompts(cfg);
  const prompt = renderPrompt({ cfg, mode: "init", repoContext: "repo facts", evidenceSummary: "evidence facts" });
  assert.match(prompt, /Resolved config snapshot/);
  assert.match(prompt, /repo facts/);
  assert.doesNotMatch(prompt, /Bearer/);
});

test("init evidence collector separates facts from risks", () => {
  const root = tempRepo();
  const evidence = collectInitEvidence(root);
  assert.equal(evidence.packageScripts.test, "node --test");
  assert.ok(evidence.dependencyFiles.includes("package.json"));
  assert.ok(evidence.observedFacts.some((fact) => fact.includes("Package scripts")));
});

test("run ledger persists prompt response config and evidence", () => {
  const root = tempRepo();
  scaffoldGuildConfig(root);
  const cfg = resolveGuildConfig({ cwd: root });
  const evidence = collectInitEvidence(root);
  const runDir = createRunLedger({ cfg, mode: "init", prompt: "prompt", response: "response", evidence });
  assert.equal(fs.existsSync(path.join(runDir, "input.json")), true);
  assert.equal(fs.existsSync(path.join(runDir, "config.snapshot.yaml")), true);
  assert.equal(fs.existsSync(path.join(runDir, "prompt.final.md")), true);
  assert.equal(fs.existsSync(path.join(runDir, "response.md")), true);
  assert.equal(fs.existsSync(path.join(runDir, "evidence", "init-evidence.json")), true);
  assert.match(fs.readFileSync(path.join(runDir, "report.md"), "utf8"), /Observed facts/);
});
