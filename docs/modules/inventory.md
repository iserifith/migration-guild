# The Inventory Pipeline Stage

## Purpose and Overview

The **Inventory** stage (`migration/guildctl/commands/inventory.ts`) is the first phase in the migration lifecycle. Its primary purpose is to scan the legacy codebase, register discoverable artifacts, establish their classification (e.g., framework and role), build a source-level dependency graph, and assess the risk level of the codebase. It ensures that the project structurally aligns with a given stack pack before allowing the migration to proceed.

Unlike simple file scanners, the Inventory pipeline enforces strict quality gates and deterministic fallback heuristics to maintain pipeline integrity. It acts as the bridge between the raw legacy filesystem and the formal registry database that powers the rest of the Autonomous Loop.

## Architecture

The Inventory phase is orchestrated by `runInventory(db, workspaceRoot, deps)` and consists of five major sub-phases:

1. **Source Scanning & Validation (`scanAndRegister`)**: Directly scans the filesystem to find matching source files.
2. **Dependency Extraction (`extractSourceDependencies`)**: Deterministically links artifacts based on code structure (e.g., imports).
3. **Agent Batch Classification**: Uses an LLM agent to analyze and classify the raw artifacts in fault-tolerant batches.
4. **Risk Assessment**: Scores each artifact’s inherent complexity/risk (e.g., length, complex query usage) via deterministic heuristics.
5. **Quality Validation (`validateInventoryQuality`)**: Runs an invariant check ensuring complete and coherent inventory data before clearing the phase.

## Step-by-Step Flow

### 1. Source Scanning and Stack Verification
The inventory process begins completely deterministically in `scanAndRegister`:
- **Language Census**: `censusSourceFiles` counts every source-like file in the `legacy/` directory by extension.
- **Stack Mismatch Fast-Fail**: It queries files matching the configured stack's `source_globs` (`pack.manifest.source_globs`). If no source files match the stack but files exist in the census, the pipeline fast-fails, suggesting a stack pack that actually aligns with the codebase.
- **Registration**: Files matching the globs are processed into canonical IDs via `deriveArtifactId` (e.g., `legacy-source:default:ClassName`). Files with identical slugs are de-duplicated or uniquely identified using path hashes (`derivePathQualifiedArtifactId`). These are then registered in the database as `first-class` artifacts.

### 2. Source Dependency Extraction
Still inside `scanAndRegister` (at `migration/guildctl/commands/inventory.ts:225`), after all files are registered, `extractSourceDependencies` is called.
- This phase reads the actual file content (if readable) and builds deterministic dependency edges based on the language (e.g., Java `import` or Python `import`).
- This graph is saved to the database (`recordAutoDependencies`) so that future planning stages understand the real relationships between components.

### 3. Agent Batch Classification
Once initial registration is complete, the process delegates semantic classification to an agent (`migration/guildctl/commands/inventory.ts:291`).
- **Batches**: To prevent timeout failures on large codebases from dropping all progress, unclassified artifacts are divided into chunks based on `inventory.classificationBatchSize`.
- **Agent Dispatch**: The `context-agent` is spawned for each batch. The agent is provided the `ClassificationSpec` contract (from `loadClassificationSpec`) and instructed to write a JSON result.
- **Idempotency & Resumes**: A persisted batch is recorded independently. If the process is halted, re-running inventory correctly resumes from the first artifact that lacks a classification.
- **Isolation Constraint**: The agent is explicitly barred from registering new artifacts; doing so triggers a strict failure condition.

### 4. Risk Assessment
Following classification, the system calculates deterministic risk metrics (Feature 005) at `migration/guildctl/commands/inventory.ts:420`.
- The `loadRiskSpec(pack)` loads the project's specific risk guidelines.
- Each artifact's content is run through `scoreArtifact` to quantify complexity or legacy code patterns that might hinder automated modernization.
- The results are aggregated and persisted via `applyBatchRiskAssessment(db, riskRecords)`.

### 5. Quality Validation
Before marking the phase complete, `validateInventoryQuality` from `migration/guildctl/classification.ts:98` enforces the Inventory Quality Gate.
- The gate evaluates coverage (`fallbackPercentage`), missing fields, unexpected registrations, and ambiguous frameworks.
- Deterministic signal checks: If the agent assigns a fallback framework but deterministic regex matches in the code indicate otherwise, the gate catches the `fallbackMissedSignals`.
- If validation fails, `recordInventoryCompletion` marks the status as `failed` and instructs the operator to manually rectify the JSON mappings. If it passes, the database transitions to readiness for the Plan phase.

## Invariants and Edge Cases

- **No Agent File Scanning**: The agent is forbidden from scanning the filesystem. The orchestrator maps the terrain explicitly (`scanAndRegister`); the agent is only allowed to semantically classify the pre-registered first-class artifacts.
- **Orphan / Ambiguous IDs**: Deduplication logic natively handles identically named files in different paths (e.g. `src/main/foo/Utils.java` and `src/main/bar/Utils.java`) by hashing the path (`derivePathQualifiedArtifactId`).
- **Resilience Against Unreadable Files**: If an artifact cannot be read off the disk, it is treated defensively. Its dependency graph insertion is bypassed and its risk assessment uses empty content, ensuring the artifact is not completely skipped over or silently missed during the tracking phases.

## Gotchas and Extension Points

- **Modifying the Classification Strategy**: When adding new frameworks or tuning the classification precision, the `stack.yaml` and `classification_spec` YAML files must be updated. Modifying `classification.ts` logic directly is usually unnecessary since the rules are driven by data (`spec.signals`).
- **Batch Resumes**: If a single batch fails entirely (e.g., repeated LLM timeouts), it will not persist, meaning those precise artifacts will be queried again on the next `guildctl run inventory` execution.
- **Risk Expansion**: To measure new types of modernization risk (e.g., manual threading, specific deprecated libraries), add new regex matches in the `risk` section of the stack pack, rather than modifying the orchestrator codebase.
