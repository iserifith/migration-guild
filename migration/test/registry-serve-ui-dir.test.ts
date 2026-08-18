/**
 * registry-serve-ui-dir.test.ts
 *
 * US2 / #123 — the Mission Control `serve` must return the built UI with no
 * manual copy, and the documented `build:dist` kit build must wire the artifacts
 * the tsup/vite pipeline actually produces (migration/registry/dist,
 * migration/guildctl/dist, migration/ui-dist) — NOT a `migration/dist` directory
 * that no build step ever creates.
 *
 * Two checks:
 *   1. startServer() serves 200 / (real index.html) and 200 /api/artifacts when
 *      migration/ui-dist exists, from the shipped bundle layout.
 *   2. build-dist.mjs's assembleTarball packages registry/dist + guildctl/dist +
 *      ui-dist and does not require migration/dist (no ENOENT on a clean checkout).
 *
 * Runs the real build inside a temp clone (mirrors build-dist-docs-skip.test.ts).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { startServer } from "../registry/commands/serve";
import { registerArtifact } from "../registry/commands/artifacts";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function fetchUrl(
  port: number,
  urlPath: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          contentType: res.headers["content-type"] ?? "",
        }),
      );
    });
    req.on("error", () => resolve({ status: 0, body: "", contentType: "" }));
  });
}

test("US2 (a): startServer serves 200 / and 200 /api/artifacts when ui-dist exists", async () => {
  const realUiDist = path.join(repoRoot, "migration", "ui-dist");
  assert.ok(
    fs.existsSync(realUiDist),
    "migration/ui-dist must be built before this test (run build:ui)",
  );

  const db = new Database(":memory:");
  applySchema(db);
  // Use the real registration API so required columns (slug, etc.) are populated.
  registerArtifact(db, {
    id: "legacy-source:core:UiCheck",
    kind: "legacy-source",
    path: "legacy/src/UiCheck.java",
    tier: "first-class",
    module: "core",
  });

  const port = 5321 + Math.floor(Math.random() * 1000);
  const server = startServer(db, port);
  await new Promise((r) => setTimeout(r, 150));

  try {
    const root = await fetchUrl(port, "/");
    assert.equal(root.status, 200, `GET / must be 200, got ${root.status}`);
    assert.match(root.contentType, /text\/html/);
    assert.match(root.body, /<html|<body|index/i);

    const api = await fetchUrl(port, "/api/artifacts");
    assert.equal(api.status, 200, `GET /api/artifacts must be 200, got ${api.status}`);
    assert.match(api.contentType, /application\/json/);
    assert.ok(api.body.includes("UiCheck"), "api must return real artifact data");
  } finally {
    server.close();
    db.close();
  }
});

test("US2 (b): build:dist packages registry/dist + guildctl/dist + ui-dist (no migration/dist ENOENT)", () => {
  const kitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mg-ui-"));
  try {
    const copy = (rel: string) => {
      const src = path.join(repoRoot, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(kitRoot, rel), {
          recursive: true,
          filter: (s) => !s.includes("node_modules"),
        });
      }
    };
    for (const f of [
      "README.md",
      "GETTING-STARTED.md",
      "AGENTS.md",
      ".env.example",
      "package.json",
      "setup.ts",
      "tsconfig.json",
    ]) {
      if (fs.existsSync(path.join(repoRoot, f)))
        fs.cpSync(path.join(repoRoot, f), path.join(kitRoot, f));
    }
    copy("package");
    copy("migration");
    copy("stacks");
    copy("scripts");
    copy("docs");
    fs.cpSync(
      path.join(repoRoot, "migration", "node_modules"),
      path.join(kitRoot, "migration", "node_modules"),
      { recursive: true },
    );
    fs.cpSync(
      path.join(repoRoot, "migration", "ui", "node_modules"),
      path.join(kitRoot, "migration", "ui", "node_modules"),
      { recursive: true },
    );
    fs.cpSync(
      path.join(repoRoot, "node_modules"),
      path.join(kitRoot, "node_modules"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(kitRoot, "dist"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "dist", "setup.js"),
      path.join(kitRoot, "dist", "setup.js"),
    );

    // Ensure source migration/dist is ABSENT so the test proves build-dist does
    // not depend on it (the old bug copied migration/dist and ENOENT'd).
    fs.rmSync(path.join(kitRoot, "migration", "dist"), {
      recursive: true,
      force: true,
    });

    let output = "";
    let status = 0;
    try {
      output = execFileSync(
        process.execPath,
        ["--import", "tsx", path.join(kitRoot, "scripts", "build-dist.mjs")],
        {
          cwd: kitRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      status = (err as { status?: number }).status ?? 1;
      output = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
    }
    assert.equal(status, 0, `build:dist must succeed, got ${status}\n${output}`);

    const tarball = path.join(kitRoot, "dist", "migration-guild-kit.tar.gz");
    assert.ok(fs.existsSync(tarball), "tarball must be produced");

    const extractDir = path.join(kitRoot, ".extract");
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarball], { cwd: extractDir, stdio: "ignore" });

    const buildRoot = path.join(extractDir, "migration-guild-kit-build");
    assert.ok(
      fs.existsSync(path.join(buildRoot, "migration", "registry", "dist")),
      "registry/dist must be packaged",
    );
    assert.ok(
      fs.existsSync(path.join(buildRoot, "migration", "guildctl", "dist")),
      "guildctl/dist must be packaged",
    );
    assert.ok(
      fs.existsSync(path.join(buildRoot, "migration", "ui-dist")),
      "ui-dist must be packaged",
    );
    assert.ok(
      !fs.existsSync(path.join(buildRoot, "migration", "dist")),
      "build-dist must NOT create/package a migration/dist directory",
    );
  } finally {
    fs.rmSync(kitRoot, { recursive: true, force: true });
  }
});
