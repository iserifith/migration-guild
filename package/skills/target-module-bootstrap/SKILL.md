---
name: target-module-bootstrap
description: "Create a minimal target module for source-only legacy Java migrations. Use when no target module exists and the migration needs src/main/java, src/test/java, build files, and an application entry point."
argument-hint: "Target module path, defaulting to modern/"
---

# Target Module Bootstrap

Use this skill when the workspace contains only legacy code and you need a destination module before migrating files.

## When to Use

- No target module exists under `modern/`.
- You need a standard project skeleton for the target framework.
- You need production and test directories ready for TDD-style migration.

## Project Type Classification

Before scaffolding, classify the legacy module to select the right build template:

| Signals in legacy code | Project type | Template to use |
|---|---|---|
| `@Path`, `@WebServlet`, `HttpServlet`, `web.xml`, REST endpoints | **Web app** | `build.gradle.web.template` |
| `@Scheduled`, batch jobs, CLI mains, queue consumers, `@Stateless` services with no HTTP layer | **Service / batch** | `build.gradle.service.template` |
| No `main()`, no server config, published as a JAR dependency, utility classes only | **Library** | `build.gradle.library.template` |

When the project type is ambiguous, default to **service** (not web). Only use the web template when HTTP-handling code is present.

## Procedure

1. Search the workspace for an existing target module under `modern/`.
2. If one exists, report it and stop.
3. Classify the legacy module using the table above.
4. If none exists, scaffold a module at `modern/` using the matching template from `./assets/`.
5. Create the minimum files:
   - Build file (build.gradle or pom.xml depending on target framework)
   - Application entry point (omit for library type — no `main()` needed)
   - `src/main/resources/application.yml` (omit for library type)
6. Create source roots:
   - `src/main/java/<package>/`
   - `src/test/java/<package>/`
   - `src/main/resources/` (skip for library type)
7. Ensure JUnit 5 is the default test framework.
8. Keep the scaffold intentionally small — migration-specific classes come later.

## Output Checklist

- Detected project type is reported (web / service / library).
- Build template selected is reported.
- Module root is reported.
- Files created are reported.
- Java package root is reported.
- Target framework version source is reported.
