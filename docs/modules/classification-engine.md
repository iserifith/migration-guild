# Classification Engine

## Purpose and Overview

The **Classification Engine** (`migration/guildctl/classification.ts`) is a foundational subsystem that brings order to the raw chaos of legacy codebases. When the `inventory` stage registers source files, those files lack semantic meaning. The Classification Engine's job is to attach deterministic labels—frameworks, architectural roles, and logical modules—to these files based on a strict `ClassificationSpec` contract defined by the active Stack Pack.

Unlike a pure LLM-driven classification approach where an agent might invent taxonomies, this engine operates under a rigid, data-driven "Closed Vocabulary" model. AI agents (like the Context Agent) may propose classifications, but the Classification Engine enforces strict validation gates, applying normalization, fallback heuristics, and deterministic overrides to ensure the resulting dataset is safe for the automated migration planner to use.

## Architecture & Data Flow

The classification process treats the LLM as an untrusted input source. Data flows through a validation pipeline:

1.  **Spec Loading**: The configuration is parsed from the stack pack's YAML.
2.  **Normalization**: Agent output is forced into the allowed vocabulary.
3.  **Deterministic Inference**: Regular expressions scan file contents to infer baseline classifications.
4.  **Batch Application**: Validated records are atomically persisted into SQLite.
5.  **Quality Gating**: An integrity sweep ensures the entire dataset meets statistical and evidential thresholds before the inventory phase can successfully close.

## Step-by-Step Flow

### 1. Loading the Spec (`loadClassificationSpec`)

The engine's ruleset is defined by the `ClassificationSpec` type (lines 8-28). The engine loads this from the `classification.yaml` (typically named in `pack.manifest.classification_spec`) via `loadClassificationSpec` (`migration/guildctl/classification.ts:100`).

This function uses `validateSpec` (line 111) to ensure the spec itself is well-formed:
- `frameworks.allowed` must contain both the configured `fallback` and `ambiguous` values.
- Signal identifiers cannot be duplicated, and each signal must reference a valid framework and role.

### 2. Data Normalization

Because agents can be imprecise (e.g., returning "spring boot" instead of "Java-Spring"), the engine normalizes strings on ingestion:

-   **`normalizeFramework`** (`line 124`): Checks the proposed framework against `spec.frameworks.allowed`. If it's missing, it checks a case-insensitive `aliases` map. If it's still unknown, it throws a hard error.
```typescript
export function normalizeFramework(spec: ClassificationSpec, raw: string): string {
  const value = raw.trim();
  const allowed = new Set(spec.frameworks.allowed);
  if (allowed.has(value)) return value;
  const lowerAliases = new Map(Object.entries(spec.frameworks.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const alias = lowerAliases.get(value.toLowerCase());
  if (alias && allowed.has(alias)) return alias;
  throw new Error(`unsupported framework "${raw}". Allowed: ${spec.frameworks.allowed.join(", ")}`);
}
```
-   **`deriveArtifactModule`** (`line 134`): The agent doesn't choose the module; the engine derives it deterministically based on `spec.modules.source_roots` regex patterns applied to the artifact's path.

### 3. Deterministic Inference (`classifyArtifactSource`)

Before relying solely on the agent, the engine can deterministically infer the framework using `classifyArtifactSource` (`line 164`).

This function reads the actual file content and iterates through `spec.signals`.
- It uses `signalMatches` (`line 149`) to evaluate `path` and `content` regexes.
```typescript
function signalMatches(signal: ClassificationSignal, artifactPath: string, content: string): boolean {
  const pathMatches = signal.match.path?.some((pattern) => regexMatches(pattern, artifactPath)) ?? false;
  const contentMatches = signal.match.content?.some((pattern) => regexMatches(pattern, content)) ?? false;
  if (signal.match.path && !pathMatches) return false;
  if (signal.match.content && !contentMatches) return false;
  return Boolean(signal.match.path || signal.match.content);
}
```
- If multiple signals match, it picks the one with the highest `priority`.
- If no signals match, it returns the `spec.frameworks.fallback`.
- This mechanism also infers roles (using `inferPlainRole`, `line 157`, which detects things like test files, interfaces, or generic DTOs).

### 4. Batch Processing and Validation (`applyBatchClassification`)

When the Context Agent returns a batch of classifications, `applyBatchClassification` (`line 281`) handles the database transaction.

First, it runs the batch through `validateBatch` (`line 212`):
- It rejects duplicate classifications within the batch.
- It ensures required fields (artifact ID, framework, role) are present.
- It coerces the agent's explanation into a structured JSON array (`coerceEvidence`, `line 238`).

Then, inside a SQLite transaction, it `UPSERT`s rows into the `artifact_classifications` table (`line 293`), storing the normalized framework, role, confidence score, and the parsed evidence. It concurrently updates the main `artifacts` table to reflect these fields.

### 5. Quality Assurance (`validateInventoryQuality`)

The final, and most critical, step is the Quality Gate enforced by `validateInventoryQuality` (`line 354`). This runs at the end of the inventory phase. It sweeps all `first-class` artifacts and produces an `InventoryValidationReport`.

It enforces several strict heuristics:
-   **Missing Fields**: Every expected artifact must have a module, role, and framework.
-   **Unexpected Registrations**: Detects if artifacts were inserted that shouldn't be there (preventing agents from hallucinating files).
-   **Fallback Concentration (`fallback_max_percentage`)**: If too many artifacts are classified as the fallback framework (e.g., > 50%), it triggers a warning or error based on `fallback_concentration` (line 439).
-   **Low Confidence Fallbacks**: Checks if the agent's confidence score for fallback items falls below `fallback_min_confidence`.
-   **`fallbackMissingNegativeEvidence`** (line 415): If an artifact is classified as fallback, the engine checks the LLM's evidence text (`parseEvidence`). If the text *does not* include the exact string required by `fallback_required_evidence` (usually `"negative-evidence"`), it flags the classification as flawed.
-   **`fallbackMissedSignals`** (line 417): The most powerful check. The engine runs its own deterministic `classifyArtifactSource` on the file. If the *agent* chose the fallback framework, but the *engine's regexes* found a specific framework signal (e.g., a Spring `@RestController` annotation), the engine catches the agent's mistake and flags the inconsistency.
```typescript
      const inferred = classifyArtifactSource(spec, { id: artifact.id, path: artifact.path }, opts.workspaceRoot ?? process.cwd());
      if (inferred.framework !== spec.frameworks.fallback && inferred.framework !== spec.frameworks.ambiguous) {
        fallbackMissedSignals.push({ id: artifact.id, expectedFramework: inferred.framework, signals: inferred.signals ?? [] });
      }
```

## Invariants and Edge Cases

-   **Closed Vocabulary**: The engine rigidly rejects any framework or role not explicitly defined in the `ClassificationSpec`. Agents cannot invent new categories.
-   **Fail-Closed Fallbacks**: The system treats the fallback classification (usually meaning "Plain Language", e.g., standard Java without a framework) with extreme suspicion. The `fallbackMissedSignals` invariant ensures that if there is hard regex evidence of a framework, a fallback classification is strictly rejected.
-   **Generic Tags**: The `genericOnlyTagCount` check (line 421) ensures that tags like "analyzed" do not count as meaningful semantic evidence if no other specific lifecycle tags exist.

## Gotchas

- **Agent Hallucinations**: Since the `normalizeFramework` function falls back on throwing hard errors for unknown frameworks, an agent completely hallucinating a framework string during batch classification will cause the entire transaction batch to fail and be retried or ultimately error out.
- **Module Derivation**: Modifying an artifact's path on disk directly without updating its database location will break `deriveArtifactModule` and trigger a `modulePathInconsistencies` error during validation, as it maps regex patterns against file paths.

## Extension Points

- **Framework Signals**: Expanding support for a new framework requires zero code changes to the orchestrator itself; you merely need to define new `signals` (with `match.path` and/or `match.content` regex rules) and add it to `frameworks.allowed` inside `classification.yaml`.
- **Role Heuristics**: The `inferPlainRole` function natively supports basic inference (like testing files or DTOs). More nuanced role deduction rules can be introduced here for different language-specific constructs.