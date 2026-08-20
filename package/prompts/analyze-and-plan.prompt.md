---
description: "Analyze the legacy Java application and produce a wave-based migration plan. Registers all artifacts, recommends the migration stack for human confirmation, then assigns dependencies and wave numbers."
---

Analyze the legacy Java application in `legacy/` and produce a complete migration plan.

1. Initialize the registry if it does not yet exist:
   ```bash
   node migration/registry/dist/cli.js init
   ```

2. Run `context-agent` on each source file in `legacy/` to classify and register all artifacts — both Java source files (first-class) and supporting config/descriptor/SQL files (second-class).

3. Run `stack-advisor` to:
   - Detect all frameworks and libraries in use across the registered artifacts
   - Propose a legacy → target mapping table
   - Record mappings in the registry

   **Pause here** and present the mapping table to the human. Wait for confirmation of all mappings before proceeding.

   To confirm mappings:
   ```bash
   node migration/registry/dist/cli.js list-mappings
   # Then for each mapping:
   node migration/registry/dist/cli.js confirm-mapping --id "<id>" --confirmed-by "<your-name>"
   ```

4. Run `planner-agent` to:
   - Verify all mappings are confirmed
   - Identify dependencies between files (first-class and second-class)
   - Assign wave numbers (topological ordering, first-class only)
   - Set all artifacts to status `planned`

5. Report the wave plan:
   ```bash
   node migration/registry/dist/cli.js wave-plan
   ```

6. Output:

### Project Summary
- **Legacy source root**: `legacy/`
- **Target root**: `modern/`
- **Project type**: (from `.github/agent-instructions.md`)
- **Total first-class files**: N
- **Total second-class files**: N

### Stack Mapping
| Legacy | Target | Strategy |
|--------|--------|----------|
| ...    | ...    | ...      |

### Wave Plan
| Wave | Files | Notes |
|---|---|---|
| 1 | N | No dependencies |
| 2 | N | Depends on Wave 1 |

### Risks
- <risk or open question>

### Next Step
Run `Migrate next task` in any Agent session to begin parallel execution.
