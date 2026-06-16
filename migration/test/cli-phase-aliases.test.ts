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

test("migration guildctl CLI recognizes run remediate", () => {
  const cwd = path.resolve(__dirname, "..");
  const scriptPath = path.join(cwd, "guildctl", "cli.ts");
  const result = runCli(scriptPath, cwd, "remediate");

  assert.notEqual(result.stderr.includes('Unknown phase: "remediate"'), true);
  assert.notEqual(result.status, 0);
});

test("migration guildctl CLI recognizes run bootstrap", () => {
  const cwd = path.resolve(__dirname, "..");
  const scriptPath = path.join(cwd, "guildctl", "cli.ts");
  const result = runCli(scriptPath, cwd, "bootstrap");

  assert.notEqual(result.stderr.includes('Unknown phase: "bootstrap"'), true);
  assert.notEqual(result.status, 0);
});
