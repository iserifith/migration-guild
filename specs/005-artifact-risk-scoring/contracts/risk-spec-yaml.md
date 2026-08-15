# Contract: `risk:` Block in Stack Pack `classification.yaml`

**Feature**: `005-artifact-risk-scoring`

This is the configuration contract between a stack-pack maintainer and the risk
scanner — what `FR-007`/`FR-008`/`FR-009` (per-pack thresholds, sane defaults,
fail-fast validation) mean concretely. Design rationale is in `../research.md` §3;
full field-level detail is in `../data-model.md` Entity 2.

## Location

An optional top-level `risk:` key inside each stack pack's classification spec file
(the file already referenced by `stack.yaml`'s `classification_spec` field and loaded
via `loadClassificationSpec`) — e.g. `stacks/java-spring/classification.yaml`,
`stacks/python/classification.yaml`.

## Schema

```yaml
risk:
  god_method_max_lines: <positive number>          # optional
  cyclomatic_complexity_limit: <positive number>    # optional
  high_risk_score_cutoff: <non-negative number>     # optional
  method_boundary:                                  # optional
    style: brace | indent
    start_pattern: <regex string>
  complexity_keywords: [<string>, ...]               # optional
  reflection_patterns:                               # optional
    - id: <string>            # unique within this pack's risk spec
      match: <regex string>
      flags: <string>         # optional, e.g. "g"; default none
      evidence: <string>      # human-readable, used to build reason codes
```

## Backward compatibility

The entire `risk:` block is optional. A stack pack that omits it entirely continues to
function unchanged (FR-008, and the spec's explicit backward-compatibility assumption)
— every field falls back to a repo-wide built-in default documented in
`../research.md` §2–§3. A stack pack MAY override only a subset of fields; unset
fields within a present `risk:` block still fall back individually (e.g. a pack can
set `god_method_max_lines` alone and inherit the default `cyclomatic_complexity_limit`).

## Validation contract (fail-fast at `loadClassificationSpec` time)

All checks run once, at pack-load time, before any artifact is scanned — never
discovered mid-scan. On failure, load throws with a message identifying the stack pack
id and the offending field, in the same style as the existing
`validateSpec` errors (e.g. `"${source}: frameworks.allowed must not be empty"`).

| Condition | Failure |
|---|---|
| `god_method_max_lines` present and not a finite number `> 0` | reject |
| `cyclomatic_complexity_limit` present and not a finite number `> 0` | reject |
| `high_risk_score_cutoff` present and not a finite number `>= 0` | reject |
| `method_boundary.style` present and not `"brace"` or `"indent"` | reject |
| `method_boundary.start_pattern` present but not a compilable `RegExp` | reject |
| `reflection_patterns[].match` not a compilable `RegExp` | reject |
| `reflection_patterns[].id` duplicated within the same pack | reject |

This satisfies FR-009 ("reject stack-pack risk configuration that is structurally
invalid... with a clear, actionable error at load time") and the spec's edge case on
invalid threshold values (negative length, cutoff below zero).

## Example (illustrative, not prescriptive of final tuning)

```yaml
# stacks/java-spring/classification.yaml (excerpt)
risk:
  god_method_max_lines: 80
  cyclomatic_complexity_limit: 15
  high_risk_score_cutoff: 50
  method_boundary:
    style: brace
    start_pattern: '(public|private|protected)[^;{]*\([^)]*\)\s*(throws\s+[\w,\s]+)?\s*\{'
  reflection_patterns:
    - id: java-class-forName
      match: '\bClass\.forName\s*\('
      evidence: "Class.forName reflective load"
    - id: java-method-invoke
      match: '\.getMethod\s*\([^)]*\)\s*\.invoke\s*\('
      evidence: "reflective Method.invoke call"
```

```yaml
# stacks/python/classification.yaml (excerpt)
risk:
  god_method_max_lines: 60
  cyclomatic_complexity_limit: 12
  high_risk_score_cutoff: 45
  method_boundary:
    style: indent
    start_pattern: '^\s*def\s+\w+\s*\('
  reflection_patterns:
    - id: python-getattr-call
      match: '\bgetattr\s*\([^,]+,\s*[^)]+\)\s*\('
      evidence: "dynamic attribute lookup + call"
    - id: python-importlib
      match: '\bimportlib\.import_module\s*\('
      evidence: "dynamic module import"
```

Consumers of this file (Phase 1 design; concrete function names finalized during
`tasks.md`): a `loadRiskSpec`-equivalent step inside (or alongside)
`loadClassificationSpec`, and the risk-scanning module invoked from
`runInventory` in `migration/guildctl/commands/inventory.ts`.
