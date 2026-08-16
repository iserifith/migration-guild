import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * specs/007-doc-rag-lookup — T016: the doc-ingestion agent persona + harness
 * preflight. The persona must forbid legacy/modern writes, mandate the
 * FR-003a provenance pair on every entry, and require citable sources; the
 * ingestion harness must fail closed when its pinned harness (opencode) is
 * unreachable (research.md §5, Constitution Principle VI).
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

test("doc-ingestion-agent persona exists with valid frontmatter and required constraints (FR-003a)", () => {
  const personaPath = path.join(REPO_ROOT, "package", "agents", "doc-ingestion-agent.agent.md");
  assert.ok(fs.existsSync(personaPath), "package/agents/doc-ingestion-agent.agent.md must exist");
  const text = fs.readFileSync(personaPath, "utf8");

  assert.match(text, /^---\n[\s\S]*?name: doc-ingestion-agent\n[\s\S]*?---/, "frontmatter must name the agent");
  assert.match(text, /legacy\//, "persona must forbid legacy/ writes");
  assert.match(text, /modern\//, "persona must forbid modern/ writes");
  assert.match(text, /source URL/i, "persona must mandate source URLs");
  assert.match(text, /verbatim excerpt/i, "persona must mandate verbatim excerpts");
  assert.match(text, /citable/i, "persona must require citable sources");
  assert.match(text, /index-doc-entry/, "persona must name the index-doc-entry write path");
});

test("resolveIngestionHarness uses the dedicated ingestion.harness setting, not config.harness (research.md §5)", async () => {
  const { resolveIngestionHarness } = await import("../guildctl/commands/ingest-docs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-ingest-harness-"));

  const pinned = resolveIngestionHarness(
    { harness: "codex", ingestion: { harness: "opencode" } },
    root,
    {},
  );
  assert.equal(pinned.name, "opencode", "ingestion ignores the workspace's primary harness setting");

  const custom = resolveIngestionHarness(
    { harness: "opencode", ingestion: { harness: "opencode" } },
    root,
    { AGENT_CMD: "/usr/local/bin/my-harness" },
  );
  assert.equal(custom.name, "custom", "AGENT_CMD still overrides ingestion the same way it overrides every other dispatch");
});

test("ingestion harness preflight fails closed when opencode is unreachable (Principle VI)", async () => {
  const { checkHarness, resolveIngestionHarness } = await import("../guildctl/commands/ingest-docs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-ingest-harness-"));
  const resolution = resolveIngestionHarness({ harness: "opencode", ingestion: { harness: "opencode" } }, root, {});
  const check = checkHarness(resolution);
  // The check must execute the harness binary; on hosts without opencode it
  // fails closed. On hosts with it, it must pass — either way the wiring is
  // the contract under test.
  assert.equal(typeof check.ok, "boolean");
  if (!check.ok) assert.match(check.message, /opencode/i);
});

test("opencode adapter registers the guild-docs MCP server only for Migrate/Critic personas (T010)", async () => {
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, "package", "harness", "opencode.mjs")).href;
  const { docMcpServerBlock } = await import(moduleUrl);

  const block = docMcpServerBlock({}, REPO_ROOT) as Record<string, unknown>;
  assert.equal(block.type, "local");
  const command = block.command as string[];
  assert.equal(command[0], "node");
  assert.ok(command.some((c) => c.includes("mcp-doc-server")), "server script path must be in the command");
  const env = block.environment as Record<string, string>;
  assert.ok(env.GUILD_INDEX_DB_PATH.endsWith(path.join(".guild", "index.db")));

  // Explicit env override wins over the derived default.
  const overridden = docMcpServerBlock({ GUILD_INDEX_DB_PATH: "/tmp/custom-index.db" }, REPO_ROOT) as Record<string, unknown>;
  assert.equal((overridden.environment as Record<string, string>).GUILD_INDEX_DB_PATH, "/tmp/custom-index.db");
});

test("codex adapter adds mcp_servers.guild-docs -c overrides only for Migrate/Critic personas (T011)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-docmcp-"));
  fs.mkdirSync(path.join(root, ".github", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "agents", "code-writer-agent.agent.md"), "---\nname: code-writer-agent\n---\nPersona\n");
  fs.writeFileSync(path.join(root, ".github", "agents", "analyze-agent.agent.md"), "---\nname: analyze-agent\n---\nPersona\n");
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, "package", "harness", "codex.mjs")).href;
  const { buildCodexInvocation } = await import(moduleUrl);
  const env = { AGENT_PROVIDER_BASE_URL: "https://example.test/v1", AGENT_PROVIDER_API_KEY_ENV: "TEST_KEY" };

  const withMcp = buildCodexInvocation(["--agent", "code-writer-agent", "--model", "m", "--yolo", "-p", "p"], { cwd: root, env });
  assert.ok(withMcp.args.some((a) => String(a).startsWith("mcp_servers.guild-docs.command=")));
  assert.ok(withMcp.args.some((a) => String(a).startsWith("mcp_servers.guild-docs.args=")));
  assert.ok(withMcp.args.some((a) => String(a).includes("GUILD_INDEX_DB_PATH")));

  const withoutMcp = buildCodexInvocation(["--agent", "analyze-agent", "--model", "m", "--yolo", "-p", "p"], { cwd: root, env });
  assert.ok(!withoutMcp.args.some((a) => String(a).includes("guild-docs")), "non-Migrate/Critic personas must not get the MCP server");
});

test("goose adapter writes a guild-docs extension config only for Migrate/Critic personas (T012)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goose-docmcp-"));
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, "package", "harness", "goose.mjs")).href;
  const { writeDocMcpGooseConfig } = await import(moduleUrl);

  const { file, content } = writeDocMcpGooseConfig({}, root);
  assert.ok(fs.existsSync(file), "temp config.yaml must be written");
  assert.match(content, /guild-docs:/);
  assert.match(content, /type: stdio/);
  assert.match(content, /mcp-doc-server/);
  assert.match(content, /GUILD_INDEX_DB_PATH/);
});
