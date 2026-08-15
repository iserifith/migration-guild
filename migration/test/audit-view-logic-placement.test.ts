import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import { listJvmAuditFindings } from "../registry/commands/modernization";
import { refreshCompatibilityAudits } from "../guildctl/audit";
import { scaffoldGuildConfig } from "../guildctl/config";
import { recordScopeDecision } from "../registry/commands/scope";

const repoRoot = path.resolve(__dirname, "..", "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function freshWorkspace(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-view-logic-placement-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "package", "stacks"), path.join(root, "package", "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
  fs.writeFileSync(path.join(root, "legacy", "build.gradle"), "");
  fs.mkdirSync(path.join(root, "legacy", "src", "main", "java", "com", "acme"), { recursive: true });
  scaffoldGuildConfig(root);
  return root;
}

function registerFirstClassArtifact(db: Database.Database, id: string, filePath: string): void {
  const moduleName = id.split(":")[1] ?? "com.acme";
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: filePath,
    tier: "first-class",
    module: moduleName,
    role: "rest-endpoint",
    framework: "spring-mvc",
  });
  recordScopeDecision(db, { module: moduleName, decision: "keep", reason: "test fixture", decidedBy: "test" });
}

// Fixture: a handler with inline validation AND inline business-rule logic,
// no *Service/*Validator collaborator anywhere in the file (spec US2
// Independent Test; quickstart.md Scenario 2).
const INLINED_HANDLER = `package com.acme;

import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

@RestController
public class OrderController {
  @PostMapping("/orders")
  public String createOrder(@RequestBody Order order) {
    if (order.getCustomerId() == null) {
      throw new IllegalArgumentException("customerId is required");
    }
    if (order.getItems().isEmpty()) {
      throw new IllegalArgumentException("items must not be empty");
    }
    double total = 0;
    for (Item item : order.getItems()) {
      total += item.getPrice();
    }
    if (total > 1000) {
      order.setDiscount(0.1);
    } else if (total > 500) {
      order.setDiscount(0.05);
    } else if (total > 100) {
      order.setDiscount(0.02);
    }
    return "created";
  }
}
`;

// Fixture: the same endpoint properly consolidated — the handler only binds
// and delegates to a dedicated *Validator/*Service (spec US1 Independent
// Test; quickstart.md Scenario 1's expected output).
const CONSOLIDATED_HANDLER = `package com.acme;

import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

@RestController
public class OrderController {
  private final OrderValidator orderValidator;
  private final OrderService orderService;

  public OrderController(OrderValidator orderValidator, OrderService orderService) {
    this.orderValidator = orderValidator;
    this.orderService = orderService;
  }

  @PostMapping("/orders")
  public String createOrder(@RequestBody Order order) {
    orderValidator.validate(order);
    orderService.process(order);
    return "created";
  }
}
`;

test("view-logic-placement rules fire on inline validation/business logic with no Service/Validator collaborator", () => {
  const root = freshWorkspace();
  const javaPath = "legacy/src/main/java/com/acme/OrderController.java";
  fs.writeFileSync(path.join(root, javaPath), INLINED_HANDLER);

  const db = createDb();
  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme:OrderController", javaPath);
    const summary = refreshCompatibilityAudits(db, root);
    assert.ok(summary.jvm.warnings >= 1, `expected at least one warning JVM finding, got ${JSON.stringify(summary.jvm)}`);

    const findings = listJvmAuditFindings(db, { artifactId: "legacy-source:com.acme:OrderController" });
    const placement = findings.filter((f) => f.category === "view-logic-placement");
    assert.ok(placement.length >= 1, `expected at least one view-logic-placement finding, got: ${JSON.stringify(findings)}`);
    for (const finding of placement) {
      assert.equal(finding.severity, "warning", `placement findings must be warning severity, got: ${JSON.stringify(finding)}`);
    }

    const validationFindings = placement.filter((f) =>
      /getCustomerId\(\) == null|getItems\(\)\.isEmpty\(\)/.test(`${f.symbol ?? ""} ${f.evidence ?? ""}`),
    );
    assert.ok(
      validationFindings.length >= 1,
      `expected an inline-validation finding, got: ${JSON.stringify(placement)}`,
    );

    const businessRuleFindings = placement.filter((f) => /else if/.test(f.evidence ?? ""));
    assert.ok(
      businessRuleFindings.length >= 1,
      `expected an inline-business-rule finding on the else-if chain, got: ${JSON.stringify(placement)}`,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("view-logic-placement rules do NOT fire on a handler that delegates to a Validator/Service", () => {
  const root = freshWorkspace();
  const javaPath = "legacy/src/main/java/com/acme/OrderController.java";
  fs.writeFileSync(path.join(root, javaPath), CONSOLIDATED_HANDLER);

  const db = createDb();
  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme:OrderController", javaPath);
    refreshCompatibilityAudits(db, root);

    const findings = listJvmAuditFindings(db, { artifactId: "legacy-source:com.acme:OrderController" });
    const placement = findings.filter((f) => f.category === "view-logic-placement");
    assert.equal(
      placement.length,
      0,
      `expected zero view-logic-placement findings on a properly consolidated handler, got: ${JSON.stringify(placement)}`,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
