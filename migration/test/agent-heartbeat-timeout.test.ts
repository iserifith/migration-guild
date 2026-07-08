import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { spawnAgent } from "../guildctl/runner";
import {
  readGuildConfig,
  resolveWorkspaceRoot,
  scaffoldGuildConfig,
  writeGuildConfig,
} from "../guildctl/config";

// Fake agent: ignores the harness args, behaves per FAKE_MODE.
//   steady  -> emit every FAKE_PERIOD_MS, then exit 0 after FAKE_DURATION_MS
//   silent  -> emit once, then go quiet forever (until killed)
//   ceiling -> emit every FAKE_PERIOD_MS forever (until the ceiling kills it)
const FAKE_AGENT = `
const mode = process.env.FAKE_MODE;
const period = Number(process.env.FAKE_PERIOD_MS || 500);
const duration = Number(process.env.FAKE_DURATION_MS || 60000);
const emit = () => process.stdout.write("tick " + Date.now() + "\\n");
if (mode === "silent") {
  emit();
  setInterval(() => {}, 1000);
} else if (mode === "ceiling") {
  setInterval(emit, period);
} else {
  const iv = setInterval(emit, period);
  setTimeout(() => { clearInterval(iv); process.exit(0); }, duration);
}
`;

const repoRoot = path.resolve(__dirname, "..", "..");

function stageWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-task07-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  const configPath = scaffoldGuildConfig(root);
  const raw = readGuildConfig(configPath);
  raw["stack"] = "java-spring";
  writeGuildConfig(raw, configPath);
  return root;
}

function withAgentEnv(root: string, fakeScript: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_CMD: fakeScript, GUILD_WORKSPACE: root };
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function runAgent(opts: {
  root: string;
  fakeScript: string;
  fakeEnv: Record<string, string>;
  inactivityMs: number;
  ceilingMs: number;
  db: Database.Database;
}): Promise<{ exitCode: number; log: string }> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-task07-logs-"));
  const prev = { ...process.env };
  process.env = withAgentEnv(opts.root, opts.fakeScript, opts.fakeEnv);
  try {
    // logDir must be set so stdout is piped (observable) — otherwise the
    // inactivity watcher cannot see output and never arms.
    return spawnAgent({
      agent: "fake-agent",
      model: "test-model",
      prompt: "test",
      db: opts.db,
      logDir,
      inactivityTimeoutMs: opts.inactivityMs,
      timeoutMs: opts.ceilingMs,
    }).then((res) => {
      let log = "";
      try {
        const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".log"));
        if (files.length) log = fs.readFileSync(path.join(logDir, files[0]), "utf8");
      } catch {}
      fs.rmSync(logDir, { recursive: true, force: true });
      return { exitCode: res.exitCode, log };
    });
  } finally {
    process.env = prev;
  }
}

test("steady-output agent survives past the old-style flat window (ceiling permitting)", async () => {
  const root = stageWorkspace();
  const fakeScript = path.join(root, "fake-agent.cjs");
  fs.writeFileSync(fakeScript, FAKE_AGENT);
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const { exitCode } = await runAgent({
      root,
      fakeScript,
      fakeEnv: { FAKE_MODE: "steady", FAKE_PERIOD_MS: "500", FAKE_DURATION_MS: "3000" },
      inactivityMs: 1500,
      ceilingMs: 60000,
      db,
    });
    assert.equal(exitCode, 0, "steady agent should finish cleanly, not be killed");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("silent agent is killed by inactivity well before the ceiling, naming last activity", async () => {
  const root = stageWorkspace();
  const fakeScript = path.join(root, "fake-agent.cjs");
  fs.writeFileSync(fakeScript, FAKE_AGENT);
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const start = Date.now();
    const { exitCode } = await runAgent({
      root,
      fakeScript,
      fakeEnv: { FAKE_MODE: "silent" },
      // inactivity 2s, ceiling 60s — kill should land ~2s, far before 60s
      inactivityMs: 2000,
      ceilingMs: 60000,
      db,
    });
    const elapsed = Date.now() - start;
    assert.equal(exitCode, 124, "silent agent should be killed (124)");
    assert.ok(elapsed < 30000, `inactivity kill should be fast, took ${elapsed}ms`);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("chatty-but-stuck agent is killed by the wall-clock ceiling", async () => {
  const root = stageWorkspace();
  const fakeScript = path.join(root, "fake-agent.cjs");
  fs.writeFileSync(fakeScript, FAKE_AGENT);
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const start = Date.now();
    const { exitCode } = await runAgent({
      root,
      fakeScript,
      fakeEnv: { FAKE_MODE: "ceiling", FAKE_PERIOD_MS: "200" },
      // emits constantly, so inactivity never trips; ceiling at 4s should fire
      inactivityMs: 2000,
      ceilingMs: 4000,
      db,
    });
    const elapsed = Date.now() - start;
    assert.equal(exitCode, 124, "ceiling should kill the chatty-stuck agent (124)");
    assert.ok(elapsed >= 3500 && elapsed < 10000, `ceiling kill ~4s, took ${elapsed}ms`);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inactivity kill flows into retry path as a normal failure (exit 124)", async () => {
  const root = stageWorkspace();
  const fakeScript = path.join(root, "fake-agent.cjs");
  fs.writeFileSync(fakeScript, FAKE_AGENT);
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const { exitCode } = await runAgent({
      root,
      fakeScript,
      fakeEnv: { FAKE_MODE: "silent" },
      inactivityMs: 1000,
      ceilingMs: 60000,
      db,
    });
    // A killed run is a failed run (124), which callers feed into their retry logic.
    assert.equal(exitCode, 124);
    const runs = db.prepare("SELECT exit_code, status FROM runs").all() as Array<{ exit_code: number; status: string }>;
    assert.ok(runs.length >= 1);
    assert.equal(runs[0]!.exit_code, 124);
    assert.equal(runs[0]!.status, "failed");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
