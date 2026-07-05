import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { runMigrate } from "../guildctl/commands/migrate";
import { runPlan } from "../guildctl/commands/plan";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import {
  approveDependencyStrategy,
  replaceDependencyFindings,
  replaceJvmAuditFindings,
} from "../registry/commands/modernization";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFirstClassArtifact(
  db: Database.Database,
  id: string,
  status: "pending" | "planned" = "pending",
): void {
  const moduleName = id.split(":")[1] ?? "com.acme";
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${moduleName.replaceAll(".", "/")}/${id.split(":")[2]}.java`,
    tier: "first-class",
    module: moduleName,
    role: "service",
    framework: "plain-java",
  });
  if (status !== "pending") {
    setArtifactStatus(db, id, status);
  }
}

function success(agent: string): AgentRunResult {
  return {
    runId: `${agent}-run`,
    agent,
    model: "test-model",
    prompt: "test prompt",
    logFile: "/tmp/guildctl-test.log",
    exitCode: 0,
  };
}

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

async function withInterceptedExit(fn: () => Promise<void>): Promise<ExitError> {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;

  try {
    await fn();
    throw new Error("expected process.exit to be called");
  } catch (error) {
    assert.ok(error instanceof ExitError, `expected ExitError, got ${error}`);
    return error;
  } finally {
    process.exit = originalExit;
  }
}

const auditSummary = {
  artifact_count: 1,
  jvm: { critical: 0, warnings: 0 },
  dependencies: { total: 0, unresolved: 0 },
  tools: [],
};

test("planning blocks on critical JVM audit findings", async () => {
  const db = createDb();
  const agents: string[] = [];

  try {
    const id = "legacy-source:com.acme:UnsafeInternalApi";
    registerFirstClassArtifact(db, id);
    replaceJvmAuditFindings(db, id, [
      {
        tool: "source-scan",
        category: "internal-api",
        severity: "critical",
        symbol: "sun.misc.Unsafe",
        summary: "Internal JDK API usage detected: sun.misc.Unsafe",
        evidence: "L12: import sun.misc.Unsafe;",
        remediation: "Replace with supported Java APIs.",
      },
    ]);

    const exit = await withInterceptedExit(() =>
      runPlan(db, {
        refreshCompatibilityAudits: () => auditSummary,
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        spawnAgent: async ({ agent }) => {
          agents.push(agent);
          return success(agent);
        },
      }),
    );

    assert.equal(exit.code, 1);
    assert.deepEqual(agents, []);
  } finally {
    db.close();
  }
});

test("planning allows progression on warning-only JVM audit findings", async () => {
  const db = createDb();
  const agents: string[] = [];

  try {
    const id = "legacy-source:com.acme:WarnOnlySecurityManager";
    registerFirstClassArtifact(db, id);
    replaceJvmAuditFindings(db, id, [
      {
        tool: "source-scan",
        category: "deprecated-api",
        severity: "warning",
        symbol: "System.setSecurityManager",
        summary: "Deprecated JVM API usage detected: System.setSecurityManager",
        evidence: "L42: System.setSecurityManager(manager);",
        remediation: "Replace with supported policy enforcement.",
      },
    ]);

    await runPlan(db, {
      refreshCompatibilityAudits: () => ({ ...auditSummary, jvm: { critical: 0, warnings: 1 } }),
      startPolling: () => () => undefined,
      getLogDir: () => "/tmp",
      spawnAgent: async ({ agent }) => {
        agents.push(agent);
        return success(agent);
      },
    });

    assert.deepEqual(agents, ["stack-advisor", "planner-agent"]);
  } finally {
    db.close();
  }
});

test("dependency gate blocks planning without an approved replacement mapping", async () => {
  const db = createDb();
  const agents: string[] = [];

  try {
    const id = "legacy-source:com.acme:LegacyLoggingService";
    registerFirstClassArtifact(db, id);
    replaceDependencyFindings(db, id, [
      {
        dependency_name: "log4j:log4j",
        current_version: "1.2.17",
        target_hint: "org.slf4j:slf4j-api",
        category: "eol",
        severity: "critical",
        summary: "EOL Log4j 1.x API detected (1.2.17)",
        details: "Legacy logger API usage detected.",
        remediation: "Approve a logging replacement strategy.",
      },
    ]);

    const exit = await withInterceptedExit(() =>
      runPlan(db, {
        refreshCompatibilityAudits: () => ({ ...auditSummary, dependencies: { total: 1, unresolved: 1 } }),
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        spawnAgent: async ({ agent }) => {
          agents.push(agent);
          return success(agent);
        },
      }),
    );

    assert.equal(exit.code, 1);
    assert.deepEqual(agents, ["stack-advisor"]);
  } finally {
    db.close();
  }
});

test("dependency gate allows planning when replacement mapping is approved", async () => {
  const db = createDb();
  const agents: string[] = [];

  try {
    const id = "legacy-source:com.acme:LegacyServletController";
    registerFirstClassArtifact(db, id);
    const [finding] = replaceDependencyFindings(db, id, [
      {
        dependency_name: "javax.servlet:javax.servlet-api",
        current_version: "4.0.1",
        target_hint: "jakarta.servlet:jakarta.servlet-api",
        category: "incompatible",
        severity: "warning",
        summary: "Legacy javax.servlet API detected (4.0.1)",
        details: "Servlet APIs must move to Jakarta for Spring Boot 3 targets.",
        remediation: "Approve the Jakarta replacement strategy.",
      },
    ]);
    approveDependencyStrategy(db, {
      findingId: finding.finding_id,
      strategy: "replace",
      targetDependency: "jakarta.servlet:jakarta.servlet-api",
      targetVersion: "6.0.0",
      approvedBy: "operator",
      rationale: "Spring Boot 3 requires the Jakarta namespace.",
    });

    await runPlan(db, {
      refreshCompatibilityAudits: () => ({ ...auditSummary, dependencies: { total: 1, unresolved: 0 } }),
      startPolling: () => () => undefined,
      getLogDir: () => "/tmp",
      spawnAgent: async ({ agent }) => {
        agents.push(agent);
        return success(agent);
      },
    });

    assert.deepEqual(agents, ["stack-advisor", "planner-agent"]);
  } finally {
    db.close();
  }
});

test("migration refuses unsafe advancement when dependency strategies are unresolved", async () => {
  const db = createDb();

  try {
    const id = "legacy-source:com.acme:LegacyJunitService";
    registerFirstClassArtifact(db, id, "planned");
    replaceDependencyFindings(db, id, [
      {
        dependency_name: "junit:junit",
        current_version: "4.13.2",
        target_hint: "org.junit.jupiter:junit-jupiter",
        category: "outdated",
        severity: "warning",
        summary: "JUnit 4-era test API detected (4.13.2)",
        details: "Generated targets use JUnit 5.",
        remediation: "Approve the JUnit 5 upgrade strategy.",
      },
    ]);

    await assert.rejects(
      () =>
        runMigrate(db, {}, {
          startPolling: () => () => undefined,
          getLogDir: () => "/tmp",
          needsBootstrap: () => false,
          spawnAgent: async ({ agent }) => success(agent),
        }),
      /Dependency modernization gate blocked migration/,
    );
  } finally {
    db.close();
  }
});
