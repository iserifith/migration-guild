import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/**
 * US9 (#150, FR-017, SC-010): the setup wizard must never exit 0 having created
 * no workspace. Headless (non-TTY stdin, no flags) it must short-circuit to the
 * default/flag-driven path and actually scaffold; piped input that runs out
 * mid-wizard must resolve remaining prompts to their documented defaults with a
 * stderr note — never the silent no-op success this regression pins.
 *
 * "An actually-scaffolded workspace" is asserted via the artifacts setup.js
 * itself installs (`.github/agent-instructions.md`, `migration/`, `package/`,
 * `stacks/`). `.guild/` is created by the separate `guildctl init` step, which
 * needs runtime deps (dotenv/better-sqlite3) absent from a staged kit, so it is
 * out of scope here.
 *
 * The kit is staged in a temp dir (setup.ts has a repo-root guard keyed on
 * package/agent-instructions.md in CWD) and setup.js is run with a separate
 * empty workspace as the working directory, as a real operator would.
 */
function stageKitAndWorkspace(): { kitRoot: string; workspace: string } {
  const kitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mg-kit-us9-"));
  const copy = (rel: string) => {
    fs.cpSync(path.join(repoRoot, rel), path.join(kitRoot, rel), {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
  };
  copy("package");
  copy("migration");
  copy("stacks");
  for (const f of [".env.example", "agent-shim.mjs", "README.md"]) {
    if (fs.existsSync(path.join(repoRoot, f))) {
      fs.copyFileSync(path.join(repoRoot, f), path.join(kitRoot, f));
    }
  }
  fs.mkdirSync(path.join(kitRoot, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "dist", "setup.js"), path.join(kitRoot, "dist", "setup.js"));

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mg-workspace-us9-"));
  return { kitRoot, workspace };
}

/**
 * Run setup.js. When `input` is omitted the child inherits NO stdin data but
 * still a non-TTY (spawnSync pipes are not TTYs); `input: ""` closes stdin
 * immediately (EOF, the `< /dev/null` case); `input: "1\n"` is partial piped
 * input that runs out after the first prompt.
 */
function runSetup(kitRoot: string, workspace: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [path.join(kitRoot, "dist", "setup.js"), ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: process.env,
    input,
    timeout: 120_000,
  });
  return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function cleanup(kitRoot: string, workspace: string) {
  fs.rmSync(kitRoot, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

/** Assert the workspace was actually scaffolded (the #150 failure created nothing). */
function assertScaffolded(workspace: string, ctx: string): void {
  assert.ok(
    fs.existsSync(path.join(workspace, ".github", "agent-instructions.md")),
    `${ctx}: .github/agent-instructions.md must be scaffolded (dirs: ${safeList(workspace)})`,
  );
  for (const dir of ["migration", "package", "stacks"]) {
    assert.ok(
      fs.existsSync(path.join(workspace, dir)),
      `${ctx}: ${dir}/ must be copied into the workspace (dirs: ${safeList(workspace)})`,
    );
  }
}

function safeList(dir: string): string {
  try {
    return fs.readdirSync(dir).join(", ") || "(empty)";
  } catch {
    return "(missing)";
  }
}

test("US9: headless run (non-TTY stdin, no flags) scaffolds a workspace and exits 0 — never a silent no-op", () => {
  const { kitRoot, workspace } = stageKitAndWorkspace();
  try {
    // spawnSync stdin is a non-TTY pipe → the up-front short-circuit (T037).
    const result = runSetup(kitRoot, workspace, []);
    assert.equal(
      result.status, 0,
      `headless run must exit 0 by scaffolding with defaults, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Done\./, `headless run must print the Done. summary:\n${result.stdout}`);
    assert.match(result.stdout, /Target framework\s*:\s*Spring Boot 3\.x/, `default framework must be confirmed:\n${result.stdout}`);
    // FR-017: a clear note records that defaults were used.
    assert.match(result.stderr, /not interactive|default/i, `a stderr note must record defaulting:\n${result.stderr}`);
    assertScaffolded(workspace, "headless run");
  } finally {
    cleanup(kitRoot, workspace);
  }
});

test("US9: stdin at immediate EOF (the `< /dev/null` case) reaches a prompt, defaults it via the close backstop, and still scaffolds", () => {
  const { kitRoot, workspace } = stageKitAndWorkspace();
  try {
    // `input: ""` closes stdin at EOF immediately. Some environments surface a
    // non-TTY stdin whose isTTY is undefined but which reports open until read;
    // either the up-front short-circuit or the per-ask close backstop must
    // resolve the prompts — never a hang and never a silent empty success.
    const result = runSetup(kitRoot, workspace, [], "");
    assert.equal(
      result.status, 0,
      `immediate-EOF run must exit 0, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Done\./, `immediate-EOF run must print Done.:\n${result.stdout}`);
    assert.match(result.stderr, /default|not interactive|closed/i, `a stderr note must record defaulting:\n${result.stderr}`);
    assertScaffolded(workspace, "immediate-EOF run");
  } finally {
    cleanup(kitRoot, workspace);
  }
});

test("US9: piped input that runs out mid-wizard resolves remaining prompts to defaults with a stderr note and still scaffolds", () => {
  const { kitRoot, workspace } = stageKitAndWorkspace();
  try {
    // One answer (framework "1"), then stdin closes before the legacy-source
    // prompt — the previously-observed #150 second-prompt failure.
    const result = runSetup(kitRoot, workspace, [], "1\n");
    assert.equal(
      result.status, 0,
      `partial-piped run must exit 0 with a scaffolded workspace, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Done\./, `partial-piped run must print Done.:\n${result.stdout}`);
    assert.match(result.stderr, /default|not interactive|closed/i, `a stderr note must record defaulting:\n${result.stderr}`);
    assertScaffolded(workspace, "partial-piped run");
  } finally {
    cleanup(kitRoot, workspace);
  }
});