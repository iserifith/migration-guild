import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, stringifySimpleYaml, type GuildConfig } from "../guildctl/config";
import { resolveAgentLaunch, toResolvedRuntimeReport, type HarnessResolution } from "../guildctl/harness";
import {
  preflightJson,
  renderPreflightReport,
  runPreflight,
  type PreflightResult,
  type PreflightStageId,
} from "../guildctl/preflight";
import { runAutoRunCommand } from "../guildctl/commands/auto-run";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";
import {
  completionBody,
  createStubFetch,
  emptyCompletionBody,
  makeTempDir,
  repoMigrationRoot,
  tsxLoaderUrl,
  writeFakeHarnessAdapter,
  type StubProviderResponse,
} from "./truthful-run-state-fixtures";

/**
 * US2 (FR-011–FR-019): preflight validates the path a run would actually take.
 *
 * Every case here is hermetic. The provider is an injectable `fetch` stub, the
 * harness is the shared fake adapter, and adapter reachability is answered by an
 * injected probe — so the suite asserts on mapping and verdicts, never on a
 * network or on a machine-installed agent CLI.
 */

const CREDENTIAL_ENV = "ROOTSYS_API_KEY";
const CREDENTIAL_VALUE = "sk-live-preflight-never-print-0123456789";

function config(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return { ...structuredClone(DEFAULT_GUILD_CONFIG), ...overrides } as GuildConfig;
}

/** A reachable adapter, answered without depending on an installed agent CLI. */
const reachableAdapter = (harness: HarnessResolution) => ({ ok: true, message: `adapter reachable: ${harness.command}` });

interface PreflightRun {
  result: PreflightResult;
  calls: ReturnType<typeof createStubFetch>["calls"];
  root: string;
}

async function preflight(
  responses: StubProviderResponse[],
  overrides: Partial<Parameters<typeof runPreflight>[0]> = {},
): Promise<PreflightRun> {
  const root = makeTempDir("guild-preflight-");
  const stub = createStubFetch(responses);
  try {
    const result = await runPreflight({
      config: config(),
      root,
      env: { [CREDENTIAL_ENV]: CREDENTIAL_VALUE },
      fetchImpl: stub.fetch,
      checkAdapter: reachableAdapter,
      ...overrides,
    });
    return { result, calls: stub.calls, root };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ─── Provider status → stage mapping (FR-015, FR-016) ────────────────────────

const MAPPING_CASES: Array<{
  name: string;
  response: StubProviderResponse;
  verdict: PreflightResult["verdict"];
  stage?: PreflightStageId;
  reason?: RegExp;
}> = [
  {
    name: "401 rejected credential",
    response: { status: 401, body: { error: { message: "Your credential is inactive" } } },
    verdict: "fail",
    stage: "authorization",
    reason: /inactive/i,
  },
  {
    name: "403 forbidden credential",
    response: { status: 403, body: { error: { message: "Forbidden for this project" } } },
    verdict: "fail",
    stage: "authorization",
    reason: /forbidden/i,
  },
  {
    name: "429 rate limited",
    response: { status: 429, body: { error: { message: "Too many requests" } } },
    verdict: "fail",
    stage: "authorization",
    reason: /too many requests/i,
  },
  {
    name: "exhausted quota body",
    response: { status: 400, body: { error: { message: "You exceeded your current quota" } } },
    verdict: "fail",
    stage: "authorization",
    reason: /quota/i,
  },
  {
    name: "404 unknown model",
    response: { status: 404, body: { error: { message: "model not found" } } },
    verdict: "fail",
    stage: "model-availability",
    reason: /model not found/i,
  },
  {
    name: "model-not-found body under another status",
    response: { status: 400, body: { error: { message: "The model `fiq/hy3-tencent` does not exist" } } },
    verdict: "fail",
    stage: "model-availability",
    reason: /does not exist/i,
  },
  {
    name: "network error",
    response: { networkError: "ECONNREFUSED rootsys.cloud:443" },
    verdict: "fail",
    stage: "response",
    reason: /ECONNREFUSED/,
  },
  {
    name: "malformed body",
    response: { bodyText: "<html>503 upstream</html>" },
    verdict: "fail",
    stage: "response",
    reason: /response shape unexpected/,
  },
  {
    // US4 / F-1.2: extra/unknown fields on the envelope are tolerated, and a
    // non-OpenAI minor shape (choices[].text) still yields a pass.
    name: "extra envelope fields and minor non-OpenAI shape are tolerated",
    response: {
      body: {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1700000000,
        model: "rootsys-1",
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        choices: [{ index: 0, finish_reason: "stop", text: "pong" }],
      },
    },
    verdict: "pass",
  },
  {
    // US4 / F-1.2: choices[].delta.content (a stream-like chunk echoed in a
    // non-streamed response) is accepted as the completion text.
    name: "delta.content nested shape is tolerated",
    response: {
      body: { choices: [{ delta: { role: "assistant", content: "pong" } }] },
    },
    verdict: "pass",
  },
  {
    name: "empty completion",
    response: { body: emptyCompletionBody() },
    verdict: "fail",
    stage: "response",
    reason: /empty completion/i,
  },
  {
    name: "2xx with a non-empty completion",
    response: { body: completionBody("pong") },
    verdict: "pass",
  },
];

for (const testCase of MAPPING_CASES) {
  test(`preflight maps ${testCase.name} to ${testCase.stage ?? "a pass"}`, async () => {
    const { result, calls } = await preflight([testCase.response]);

    assert.equal(result.verdict, testCase.verdict, JSON.stringify(result));
    assert.equal(result.failedStage, testCase.stage);
    if (testCase.reason) assert.match(result.reason ?? "", testCase.reason);
    // FR-012: one completion, never a second one to probe adapter fidelity.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/rootsys\.cloud\/v1\//);
    assert.equal(calls[0].method, "POST");
    // FR-013: the resolved block is reported on pass and on fail alike.
    assert.equal(result.resolved?.model, DEFAULT_GUILD_CONFIG.model.model);
    assert.equal(result.resolved?.providerBaseUrl, "https://rootsys.cloud/v1");
    assert.equal(result.resolved?.credentialEnv, CREDENTIAL_ENV);
  });
}

test("a resolvable adapter whose provider request returns an empty completion is not a pass", async () => {
  const root = makeTempDir("guild-preflight-adapter-");
  try {
    // A genuinely present, runnable bundled adapter — resolution has nothing to
    // complain about. FR-012: that is still not a model check.
    const adapterDir = path.join(root, "harness");
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.copyFileSync(writeFakeHarnessAdapter(root), path.join(adapterDir, "opencode.mjs"));

    const stub = createStubFetch([{ body: emptyCompletionBody() }]);
    const result = await runPreflight({
      config: config(),
      root,
      env: { [CREDENTIAL_ENV]: CREDENTIAL_VALUE },
      fetchImpl: stub.fetch,
      checkAdapter: (harness) => ({ ok: fs.existsSync(harness.command), message: harness.command }),
    });

    assert.equal(result.resolved?.harness.command, path.join(adapterDir, "opencode.mjs"));
    assert.equal(result.stages.find((stage) => stage.id === "resolution")?.status, "pass");
    assert.equal(result.verdict, "fail");
    assert.equal(result.failedStage, "response");
    assert.match(result.reason ?? "", /empty completion/i);
    assert.equal(stub.calls.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an environment-sourced harness is still gated by the live provider request", async () => {
  const root = makeTempDir("guild-preflight-agentcmd-");
  try {
    const adapter = writeFakeHarnessAdapter(root);
    const rejected = createStubFetch([{ status: 401, body: { error: { message: "inactive credential" } } }]);
    const failed = await runPreflight({
      config: config(),
      root,
      env: { AGENT_CMD: adapter, [CREDENTIAL_ENV]: CREDENTIAL_VALUE },
      fetchImpl: rejected.fetch,
    });

    // AGENT_CMD changes which program runs; it does not buy an exemption from
    // proving the resolved provider can answer.
    assert.equal(failed.resolved?.harness.source, "environment");
    assert.equal(failed.verdict, "fail");
    assert.equal(failed.failedStage, "authorization");
    assert.equal(rejected.calls.length, 1);

    const accepted = createStubFetch([{ body: completionBody() }]);
    const passed = await runPreflight({
      config: config(),
      root,
      env: { AGENT_CMD: adapter, [CREDENTIAL_ENV]: CREDENTIAL_VALUE },
      fetchImpl: accepted.fetch,
    });
    assert.equal(passed.verdict, "pass");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight fails at resolution — before spending a completion — when the resolved path is incomplete", async () => {
  const missingCredential = await preflight([{ body: completionBody() }], { env: {} });
  assert.equal(missingCredential.result.verdict, "fail");
  assert.equal(missingCredential.result.failedStage, "resolution");
  assert.match(missingCredential.result.reason ?? "", new RegExp(CREDENTIAL_ENV));
  assert.equal(missingCredential.calls.length, 0);

  const unknownHarness = await preflight([{ body: completionBody() }], { config: config({ harness: "nope" }) });
  assert.equal(unknownHarness.result.verdict, "fail");
  assert.equal(unknownHarness.result.failedStage, "resolution");
  assert.match(unknownHarness.result.reason ?? "", /Unknown harness/);
  assert.equal(unknownHarness.calls.length, 0);

  const unreachableAdapter = await preflight([{ body: completionBody() }], {
    checkAdapter: () => ({ ok: false, message: "active harness: opencode (missing adapter)" }),
  });
  assert.equal(unreachableAdapter.result.verdict, "fail");
  assert.equal(unreachableAdapter.result.failedStage, "resolution");
  assert.match(unreachableAdapter.result.reason ?? "", /missing adapter/);
  assert.equal(unreachableAdapter.calls.length, 0);
});

test("budget elapse returns fail citing the elapsed budget instead of hanging", async () => {
  const started = Date.now();
  const { result, calls } = await preflight([{ delayMs: 5_000, body: completionBody() }], { budgetSeconds: 0.05 });

  assert.equal(result.verdict, "fail");
  assert.equal(result.failedStage, "response");
  assert.match(result.reason ?? "", /budget/i);
  assert.match(result.reason ?? "", /0\.05/);
  assert.equal(result.budgetSeconds, 0.05);
  assert.ok(result.elapsedMs >= 0);
  assert.equal(calls.length, 1);
  // It returned on the budget, not after the provider finally answered.
  assert.ok(Date.now() - started < 4_000, "preflight must not wait out a hung provider");
});

test("the shared budget defaults to the configured preflight budget", async () => {
  const { result } = await preflight([{ body: completionBody() }]);
  assert.equal(result.budgetSeconds, DEFAULT_GUILD_CONFIG.preflight.budget_seconds);

  const configured = await preflight([{ body: completionBody() }], {
    config: config({ preflight: { budget_seconds: 7 } }),
  });
  assert.equal(configured.result.budgetSeconds, 7);

  // The CLI override applies per invocation, over the configured value.
  const overridden = await preflight([{ body: completionBody() }], {
    config: config({ preflight: { budget_seconds: 7 } }),
    budgetSeconds: 3,
  });
  assert.equal(overridden.result.budgetSeconds, 3);
});

// ─── Offline (FR-018) ────────────────────────────────────────────────────────

test("--offline returns the third verdict unvalidated and never pass", async () => {
  const { result, calls } = await preflight([{ body: completionBody() }], { offline: true });

  assert.equal(result.verdict, "unvalidated");
  assert.notEqual(result.verdict, "pass");
  assert.equal(calls.length, 0, "offline mode issues no live call");
  assert.equal(result.failedStage, undefined);
  // The live-dependent stage is labelled, not silently dropped.
  assert.equal(result.stages.find((stage) => stage.id === "resolution")?.status, "pass");
  assert.ok(result.stages.some((stage) => stage.status === "unvalidated"));
  // FR-013: the resolved block is still reported.
  assert.equal(result.resolved?.model, DEFAULT_GUILD_CONFIG.model.model);
  assert.match(renderPreflightReport(result), /unvalidated/i);
  assert.equal(preflightJson(result).verdict, "unvalidated");
});

test("offline does not paper over a resolution failure", async () => {
  const { result, calls } = await preflight([{ body: completionBody() }], { offline: true, env: {} });
  assert.equal(result.verdict, "fail");
  assert.equal(result.failedStage, "resolution");
  assert.equal(calls.length, 0);
});

// ─── Divergence + redaction (FR-014, FR-019) ─────────────────────────────────

test("divergences are reported even when the live check succeeds", async () => {
  const { result } = await preflight([{ body: completionBody() }], {
    env: { [CREDENTIAL_ENV]: CREDENTIAL_VALUE, AGENT_PROVIDER_BASE_URL: "https://ambient.example/v1" },
  });

  assert.equal(result.verdict, "pass");
  const divergence = result.divergences.find((item) => item.setting === "model.base_url");
  assert.ok(divergence, "a resolved value differing from project configuration is always reported");
  assert.equal(divergence.declaredValue, "https://rootsys.cloud/v1");
  assert.equal(divergence.resolvedValue, "https://ambient.example/v1");

  const json = preflightJson(result) as { divergences: Array<Record<string, string>> };
  assert.deepEqual(json.divergences, [
    { setting: "model.base_url", declared: "https://rootsys.cloud/v1", resolved: "https://ambient.example/v1" },
  ]);
  assert.match(renderPreflightReport(result), /model\.base_url/);
});

test("the credential value appears in no output path while its setting name always does", async () => {
  // The provider is adversarial: it echoes the key back in its error body.
  const { result, calls } = await preflight([
    { status: 401, body: { error: { message: `invalid key ${CREDENTIAL_VALUE}` } } },
  ]);

  const surfaces = [
    JSON.stringify(result),
    JSON.stringify(preflightJson(result)),
    renderPreflightReport(result),
  ];
  for (const surface of surfaces) {
    assert.equal(surface.includes(CREDENTIAL_VALUE), false, "FR-019: the credential value never reaches output");
    assert.ok(surface.includes(CREDENTIAL_ENV), "FR-019: the credential setting name is always named");
  }

  // It really did authenticate — the value lives only in the request.
  assert.match(String(calls[0].headers["authorization"] ?? ""), new RegExp(CREDENTIAL_VALUE));

  const passing = await preflight([{ body: completionBody() }]);
  const passingReport = renderPreflightReport(passing.result);
  assert.equal(passingReport.includes(CREDENTIAL_VALUE), false);
  assert.ok(passingReport.includes(CREDENTIAL_ENV));
});

// ─── One resolver for preflight and the runner (FR-011) ──────────────────────

test("preflight and the runner resolve through the same resolveAgentLaunch()", async () => {
  const root = makeTempDir("guild-preflight-resolver-");
  try {
    const env = { [CREDENTIAL_ENV]: CREDENTIAL_VALUE, AGENT_CMD: writeFakeHarnessAdapter(root) };
    const stub = createStubFetch([{ body: completionBody() }]);
    const result = await runPreflight({ config: config(), root, env, fetchImpl: stub.fetch });

    // Identical to what the runner would launch — not a second answer that
    // happens to agree today.
    assert.deepEqual(result.resolved, toResolvedRuntimeReport(resolveAgentLaunch({ config: config(), root, env })));
    assert.equal("agentEnv" in (result.resolved ?? {}), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── doctor delegates to preflight (T035) ────────────────────────────────────

function cliFixture(prefix: string): { root: string; dbPath: string; adapter: string } {
  const root = makeTempDir(prefix);
  fs.mkdirSync(path.join(root, ".guild", "prompts", "default"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".guild", "config.yaml"),
    stringifySimpleYaml({
      ...DEFAULT_GUILD_CONFIG,
      evidence: { ...DEFAULT_GUILD_CONFIG.evidence, include_git_diff: false },
    } as unknown as Record<string, unknown>),
  );
  const dbPath = path.join(root, ".guild", "registry.db");
  const db = new Database(dbPath);
  try {
    applySchema(db);
  } finally {
    db.close();
  }
  return { root, dbPath, adapter: writeFakeHarnessAdapter(root) };
}

function runCli(args: string[], fixture: { root: string; dbPath: string; adapter: string }): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_CMD: fixture.adapter, [CREDENTIAL_ENV]: CREDENTIAL_VALUE };
  delete env["GUILD_PREFLIGHT_OFFLINE"];
  delete env["AGENT_PROVIDER_BASE_URL"];
  const result = spawnSync(process.execPath, [
    "--import",
    tsxLoaderUrl(),
    path.join(repoMigrationRoot(), "guildctl", "cli.ts"),
    "--workspace",
    fixture.root,
    "--db",
    fixture.dbPath,
    ...args,
  ], { cwd: repoMigrationRoot(), encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("guildctl preflight --offline reports unvalidated, prints the resolved block, and exits 0", () => {
  const fixture = cliFixture("guild-preflight-cli-");
  try {
    const { status, output } = runCli(["preflight", "--offline", "--json"], fixture);
    const payload = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as Record<string, any>;

    assert.equal(payload.verdict, "unvalidated");
    assert.equal(payload.resolved.model, DEFAULT_GUILD_CONFIG.model.model);
    assert.equal(payload.resolved.credential_env, CREDENTIAL_ENV);
    assert.equal(output.includes(CREDENTIAL_VALUE), false);
    assert.equal(status, 0, output);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("guildctl preflight exits 1 on a failing verdict and still prints the resolved block", () => {
  const fixture = cliFixture("guild-preflight-cli-fail-");
  try {
    // Offline keeps this hermetic; resolution still fails because the
    // credential variable the resolved path needs is not set.
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_CMD: fixture.adapter, GUILD_PREFLIGHT_OFFLINE: "1" };
    delete env[CREDENTIAL_ENV];
    const result = spawnSync(process.execPath, [
      "--import",
      tsxLoaderUrl(),
      path.join(repoMigrationRoot(), "guildctl", "cli.ts"),
      "--workspace",
      fixture.root,
      "--db",
      fixture.dbPath,
      "preflight",
      "--json",
    ], { cwd: repoMigrationRoot(), encoding: "utf8", env });
    const output = `${result.stdout}${result.stderr}`;
    const payload = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as Record<string, any>;

    assert.equal(payload.verdict, "fail");
    assert.equal(payload.failed_stage, "resolution");
    assert.equal(payload.resolved.credential_env, CREDENTIAL_ENV);
    assert.equal(result.status, 1, output);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor delegates its model, harness, and credential checks to preflight", () => {
  const fixture = cliFixture("guild-doctor-preflight-");
  try {
    const { output } = runCli(["doctor", "--offline"], fixture);

    // The offline verdict is reported as unvalidated — never as a green tick.
    assert.match(output, /preflight/i);
    assert.match(output, /unvalidated/i);
    assert.doesNotMatch(output, /✓ preflight/);
    assert.doesNotMatch(output, /model configured:/);
    assert.doesNotMatch(output, new RegExp(`✓ ${CREDENTIAL_ENV} present`));
    // The checks doctor keeps are untouched.
    assert.match(output, /config loaded:/);
    assert.match(output, /prompt pack:/);
    assert.match(output, /run ledger directory writable/);
    assert.match(output, /Pipeline state:/);
    assert.ok(output.includes(CREDENTIAL_ENV));
    assert.equal(output.includes(CREDENTIAL_VALUE), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ─── The autonomous queue gate (T035) ────────────────────────────────────────

function queueDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedPlanned(db: Database.Database, name: string): string {
  const id = `legacy-source:com.acme:${name}`;
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: `legacy/${name}.java` });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "planned");
  return id;
}

function stubVerdict(verdict: PreflightResult["verdict"], failedStage?: PreflightStageId): PreflightResult {
  return {
    verdict,
    failedStage,
    resolved: {
      harness: { name: "opencode", command: "/kit/harness/opencode.mjs", targetCommand: "opencode", source: "config" },
      providerBaseUrl: "https://rootsys.cloud/v1",
      model: DEFAULT_GUILD_CONFIG.model.model,
      credentialEnv: CREDENTIAL_ENV,
      divergences: [],
    },
    divergences: [],
    stages: [{ id: "resolution", status: "pass" }],
    elapsedMs: 12,
    budgetSeconds: 30,
    reason: failedStage ? `stubbed ${verdict}` : undefined,
  };
}

test("auto-run dispatches only after one shared preflight verdict passes", async () => {
  const db = queueDb();
  try {
    seedPlanned(db, "QueueOne");
    seedPlanned(db, "QueueTwo");
    const dispatched: string[] = [];
    let preflightCalls = 0;

    const result = await runAutoRunCommand(db, {
      wave: 1,
      registryDbPath: "/tmp/guild-preflight-queue-registry.db",
      setExitCode: false,
      json: true,
    }, {
      preflight: async () => {
        preflightCalls += 1;
        return stubVerdict("pass");
      },
      executeArtifact: async ({ artifactId }) => {
        dispatched.push(artifactId);
        setArtifactStatus(db, artifactId, "reviewed");
        return { status: "complete", runId: `run-${dispatched.length}`, attempts: 1 };
      },
      write: () => {},
    });

    assert.equal(result.status, "complete");
    assert.equal(dispatched.length, 2);
    // One verdict for the queue, not one live request per artifact.
    assert.equal(preflightCalls, 1);
  } finally {
    db.close();
  }
});

for (const blocking of ["fail", "unvalidated"] as const) {
  test(`auto-run claims nothing when the shared preflight verdict is ${blocking}`, async () => {
    const db = queueDb();
    try {
      const id = seedPlanned(db, "QueueBlocked");
      let dispatched = 0;

      await assert.rejects(
        () => runAutoRunCommand(db, {
          wave: 1,
          registryDbPath: "/tmp/guild-preflight-blocked-registry.db",
          setExitCode: false,
        }, {
          preflight: async () => stubVerdict(blocking, blocking === "fail" ? "authorization" : undefined),
          executeArtifact: async () => {
            dispatched += 1;
            return { status: "complete", runId: "run-never", attempts: 1 };
          },
          write: () => {},
        }),
        new RegExp(`preflight ${blocking}`),
      );

      assert.equal(dispatched, 0, "no artifact is dispatched on a non-passing verdict");
      const claims = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims").get() as { n: number };
      assert.equal(claims.n, 0, "no artifact is claimed before the verdict is known good");
      const status = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
      assert.equal(status.status, "planned");
    } finally {
      db.close();
    }
  });
}

// ─── US4 (FR-010..FR-012, F-1.2): completion shape tolerance + raw-body excerpt ──

test("T041: completionText tolerates extra/unknown envelope fields and nested shapes", async () => {
  const ok = await preflight([{ body: {
    id: "cmpl-9",
    object: "chat.completion",
    created: 1700000000,
    model: "rootsys-1",
    usage: { prompt_tokens: 1, total_tokens: 2 },
    system_fingerprint: "fp-abc",
    choices: [{ index: 0, finish_reason: "stop", text: "pong" }],
  } }]);
  assert.equal(ok.result.verdict, "pass", JSON.stringify(ok.result));
});

test("T042: a malformed body fails with 'response shape unexpected' and a redacted excerpt, never 'malformed response body'", async () => {
  const { result } = await preflight([{ bodyText: "not json at all <html>oops</html>" }]);
  assert.equal(result.verdict, "fail");
  assert.equal(result.failedStage, "response");
  assert.ok(result.reason, "a reason is reported");
  assert.match(result.reason!, /response shape unexpected/);
  assert.doesNotMatch(result.reason!, /provider returned a malformed response body/);
  assert.match(result.reason!, /body excerpt:/);
});

test("T043: the malformed-body excerpt redacts the credential value (FR-019)", async () => {
  // The credential value sits in the env, but a provider could echo it back in
  // a garbage body. Confirm it never survives into the reported reason.
  const echoed = `oops ${CREDENTIAL_VALUE} leaked`;
  const { result, calls } = await preflight([{ bodyText: echoed }]);
  assert.equal(result.verdict, "fail");
  assert.doesNotMatch(result.reason ?? "", new RegExp(CREDENTIAL_VALUE));
  assert.match(result.reason ?? "", /<redacted>/);
  // The credential must also never have been sent in a way that leaks into the
  // call record's plaintext body (it rides the Authorization header, not body).
  assert.equal(calls.length, 1);
});

test("T044: a reachable provider that answers with an unparseable body is distinguished from one that is unreachable", async () => {
  const shape = await preflight([{ bodyText: "not json at all" }]);
  assert.match(shape.result.reason ?? "", /response shape unexpected/);
  assert.doesNotMatch(shape.result.reason ?? "", /provider unreachable/);

  const unreachable = await preflight([{ networkError: "ECONNREFUSED rootsys.cloud:443" }]);
  assert.match(unreachable.result.reason ?? "", /provider unreachable/);
  assert.doesNotMatch(unreachable.result.reason ?? "", /response shape unexpected/);
});

test("T045: a delta.content shape (streamed chunk echoed non-streamed) passes and reports the completion", async () => {
  const { result } = await preflight([{ body: { choices: [{ delta: { content: "pong" } }] } }]);
  assert.equal(result.verdict, "pass", JSON.stringify(result));
});
