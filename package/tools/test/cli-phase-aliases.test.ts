import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

function runCli(scriptPath: string, cwd: string, phase: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "run", phase],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        DOTENV_CONFIG_SILENT: "true",
      },
    },
  );
}

test("migration legmod CLI recognizes run remediate", () => {
  const cwd = "/Users/seri/Workspace/legmod/migration";
  const scriptPath = path.join(cwd, "legmod", "cli.ts");
  const result = runCli(scriptPath, cwd, "remediate");
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  assert.doesNotMatch(combinedOutput, /Unknown phase:\s*"remediate"/);
});

test("migration legmod CLI recognizes run bootstrap", () => {
  const cwd = "/Users/seri/Workspace/legmod/migration";
  const scriptPath = path.join(cwd, "legmod", "cli.ts");
  const result = runCli(scriptPath, cwd, "bootstrap");
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  assert.doesNotMatch(combinedOutput, /Unknown phase:\s*"bootstrap"/);
});
