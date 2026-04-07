import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bootstrapTargetModule,
  detectBootstrapProjectType,
  deriveBootstrapBasePackage,
  isBootstrapComplete,
} from "../legmod/commands/bootstrap";

function createAssetsDir(workspace: string): string {
  const assetsDir = path.join(workspace, ".github", "skills", "target-module-bootstrap", "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(path.join(assetsDir, "build.gradle.web.template"), "group = 'com.example'\nimplementation 'web'\n");
  writeFileSync(path.join(assetsDir, "build.gradle.service.template"), "group = 'com.example'\nimplementation 'service'\n");
  writeFileSync(path.join(assetsDir, "build.gradle.library.template"), "group = 'com.example'\nimplementation 'library'\n");
  writeFileSync(path.join(assetsDir, "Application.java.template"), "package com.example.migrated;\npublic class Application {}\n");
  writeFileSync(path.join(assetsDir, "application.yml.template"), "spring:\n  application:\n    name: migrated-app\n");
  return assetsDir;
}

test("bootstrapTargetModule scaffolds a web target module", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "legmod-bootstrap-"));

  try {
    const assetsDir = createAssetsDir(workspace);
    const artifacts = [
      {
        path: "legacy/src/main/java/com/acme/web/CouponResource.java",
        module: "com.acme.coupon",
        role: "rest-endpoint",
        framework: "spring-mvc",
      },
    ];

    const result = bootstrapTargetModule(workspace, artifacts, assetsDir);

    assert.equal(result.projectType, "web");
    assert.equal(result.basePackage, "com.acme.coupon");
    assert.ok(result.created.includes("modern/build.gradle"));
    assert.ok(result.created.includes("modern/settings.gradle"));
    assert.ok(
      readFileSync(
        path.join(workspace, "modern", "src", "main", "java", "com", "acme", "coupon", "Application.java"),
        "utf-8",
      ).includes("package com.acme.coupon;"),
    );
    assert.ok(isBootstrapComplete(workspace, "web"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("project type and base package are inferred from artifact signals", () => {
  const artifacts = [
    { path: "legacy/a.java", module: "schwarz.jobs.interview.coupon.web", role: "rest-endpoint", framework: "spring-mvc" },
    { path: "legacy/b.java", module: "schwarz.jobs.interview.coupon.core", role: "service", framework: "spring-boot" },
  ];

  assert.equal(detectBootstrapProjectType(artifacts), "web");
  assert.equal(deriveBootstrapBasePackage(artifacts), "schwarz.jobs.interview.coupon");
});
