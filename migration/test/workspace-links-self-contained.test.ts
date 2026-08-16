import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scaffoldWorkspaceLinks } from "../guildctl/config";

// Regression coverage for issue #130 / #114: `guildctl init` must not require a
// sibling toolkit-root checkout. A self-contained workspace (produced by setup.ts
// or a distributed tarball) already carries real migration/ package/ stacks/ dirs,
// so scaffoldWorkspaceLinks must leave them as-is instead of trying to symlink
// against a toolkit root and throwing "missing toolkit target".
test("scaffoldWorkspaceLinks leaves real sibling dirs in place (no toolkit root)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-links-"));
  for (const name of ["migration", "package", "stacks"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, ".keep"), "");
  }

  // No toolkit root exists anywhere near this dir — would have thrown before #130.
  assert.doesNotThrow(() => scaffoldWorkspaceLinks(root, path.join(root, "does-not-exist")));

  for (const name of ["migration", "package", "stacks"]) {
    const p = path.join(root, name);
    const stat = fs.lstatSync(p);
    assert.ok(stat.isDirectory(), `${name}/ should remain a real directory`);
    assert.ok(!stat.isSymbolicLink(), `${name}/ must not be replaced by a symlink`);
    assert.equal(fs.readFileSync(path.join(p, ".keep"), "utf8"), "");
  }
});

test("scaffoldWorkspaceLinks still links missing dirs to a toolkit root when absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-links-link-"));
  const toolkit = fs.mkdtempSync(path.join(os.tmpdir(), "guild-toolkit-"));
  for (const name of ["migration", "package", "stacks"]) {
    fs.mkdirSync(path.join(toolkit, name), { recursive: true });
    fs.writeFileSync(path.join(toolkit, name, "toolkit-marker"), "");
  }

  scaffoldWorkspaceLinks(root, toolkit);

  for (const name of ["migration", "package", "stacks"]) {
    const linkPath = path.join(root, name);
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), `${name}/ should be symlinked to toolkit`);
    assert.equal(fs.readFileSync(path.join(linkPath, "toolkit-marker"), "utf8"), "");
  }
});
