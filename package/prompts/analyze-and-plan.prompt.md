---
description: "Analyze the legacy Java application and produce a wave-based migration plan. Registers all artifacts and assigns dependencies and wave numbers."
---

Analyze the legacy Java application in `legacy/` and produce a complete migration plan.

1. Initialize the registry if it does not yet exist:
   ```bash
   node migration/registry/dist/cli.js init
   ```

2. Run `context-agent` on each Java source file in `legacy/` to classify and register all artifacts.

3. Run `planner-agent` to:
   - Identify dependencies between files
   - Assign wave numbers (topological ordering)
   - Set all artifacts to status `planned`

4. Report the wave plan:
   ```bash
   node migration/registry/dist/cli.js wave-plan
   ```

5. Output:

### Project Summary
- **Legacy source root**: `legacy/`
- **Target root**: `modern/`
- **Target framework**: (from `.github/copilot-instructions.md`)
- **Total files**: N

### Wave Plan
| Wave | Files | Notes |
|---|---|---|
| 1 | N | No dependencies |
| 2 | N | Depends on Wave 1 |

### Risks
- <risk or open question>

### Next Step
Run `Migrate next task` in any Copilot session to begin parallel execution.
