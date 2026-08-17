import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// Lay down a minimal, self-contained kit checkout in a temp dir (NOT a
// migration workspace — setup.ts has a repo-root guard keyed on
// package/agent-instructions.md in CWD). The kit root holds package/, migration/,
// stacks/ and dist/setup.js. We also create a SEPARATE empty workspace dir and run
// setup.js with that as the working directory, as a real operator would.
function stageKitAndWorkspace(): { kitRoot: string; workspace: string } {
  const kitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mg-kit-"));
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

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mg-workspace-"));
  return { kitRoot, workspace };
}

function runSetup(kitRoot: string, workspace: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [path.join(kitRoot, "dist", "setup.js"), ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: process.env,
    input,
    timeout: 120_000,
  });
  // setup.ts routes the fail-closed "path not found" error to stderr
  // (console.error) but the no-legacy warning to stdout (console.log); tests
  // assert against both, so expose the combined stream.
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ...result, stdout: combined };
}

const WARN_HEADING = "⚠ WARNING: No legacy source was provided";
const WARN_BODY = "legacy/ is empty (0 files).";

test("US2: bare `node setup.js --yes` warns (no legacy source) and exits 0", () => {
  const { kitRoot, workspace } = stageKitAndWorkspace();
  try {
    const result = runSetup(kitRoot, workspace, ["--yes"]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);
    assert.ok(result.stdout.includes(WARN_HEADING), `missing warning heading in:\n${result.stdout}`);
    assert.ok(result.stdout.includes(WARN_BODY), `missing warning body in:\n${result.stdout}`);
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US2: non-interactive --legacy-url suppresses the no-legacy warning", () => {
  const { kitRoot, workspace } = stageKitAndWorkspace();
  try {
    // A syntactically supplied URL (we don't actually clone in this smoke test)
    // must mean we are NOT in the no-legacy case, so the warning must NOT fire.
    const result = runSetup(kitRoot, workspace, ["--yes", "--legacy-url", "https://example.com/does-not-clone.git"]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);
    assert.equal(
      result.stdout.includes(WARN_HEADING),
      false,
      `warning should be suppressed when a legacy URL is supplied:\n${result.stdout}`,
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US3: --legacy-path populates legacy/ (reuses the copy branch) and reports files copied", () => {
  const { kitRoot, workspace } = stageKitAndWorkspace();
  try {
    // Real legacy fixture shipped with the kit. US3's interactive local-path
    // choice reuses the existing --legacy-path copy branch (setup.ts ~277-287);
    // driving it via the flag exercises that exact code path deterministically
    // (multi-step piped readline is unreliable under the test runner).
    const sourceDir = path.join(repoRoot, "package", "mock", "legacy-python-utils");
    assert.ok(fs.existsSync(sourceDir), `legacy fixture missing: ${sourceDir}`);
    const result = runSetup(kitRoot, workspace, ["--yes", "--legacy-path", sourceDir]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);
    assert.ok(
      result.stdout.includes("files copied into legacy/"),
      `expected 'files copied' report in:\n${result.stdout}`,
    );
    const legacyDir = path.join(workspace, "legacy");
    assert.ok(fs.existsSync(legacyDir), "legacy/ should be populated");
    const copied = fs.readdirSync(legacyDir, { recursive: true } as never);
    assert.ok(copied.length > 0, "legacy/ should contain copied files");
    assert.equal(
      result.stdout.includes(WARN_HEADING),
      false,
      `warning must NOT fire when a valid local path is supplied:\n${result.stdout}`,
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US3: --legacy-path with a missing directory yields a clear error and the no-legacy warning still fires", () => {
  const { kitRoot, workspace } = stageKitAndWorkspace();
  try {
    const bogus = path.join(os.tmpdir(), "mg-does-not-exist-xyz");
    const result = runSetup(kitRoot, workspace, ["--yes", "--legacy-path", bogus]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);
    assert.ok(
      result.stdout.includes("not found") || result.stdout.includes("✗ Legacy path"),
      `expected a clear 'path not found' error in:\n${result.stdout}`,
    );
    // FR-007 still applies: a failed/invalid path does not count as "legacy supplied".
    assert.ok(result.stdout.includes(WARN_HEADING), `warning must fire for invalid path:\n${result.stdout}`);
    assert.ok(result.stdout.includes(WARN_BODY), `warning body must fire for invalid path:\n${result.stdout}`);
    // FR-012: invalid path must NOT populate legacy/. (runInstall only scaffolds
    // legacy/ on a successful copy; an invalid path leaves legacyPath undefined,
    // so no legacy/ dir is created — that is correct fail-closed behavior.)
    const legacyDir = path.join(workspace, "legacy");
    const files = fs.existsSync(legacyDir) ? fs.readdirSync(legacyDir) : [];
    assert.ok(
      files.length === 0,
      `invalid path must NOT populate legacy/ (got: ${files.join(",")})`,
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
