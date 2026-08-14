# Contract: `view_contract` block in `stack.yaml`

**Audience**: stack-pack authors; agents reading the active pack.
**File**: `stacks/<pack>/stack.yaml` and `package/stacks/<pack>/stack.yaml` (mirrored).

## Shape

```yaml
view_contract:
  format: openapi            # REQUIRED when the pack has web output. Primary contract format
                             # produced for migrated view-handling modules.
  style: rest                # OPTIONAL free-form hint (rest | mcp-tools | ...).
  alternates: [mcp-tools]    # OPTIONAL list of acceptable additional formats.
  drop_rule: presentational  # REQUIRED. Purely-presentational views are recorded as
                             # intentionally dropped, never regenerated.
```

## Semantics

- Presence of `view_contract` declares: "legacy view-handling modules in this pack map to
  structured API contracts in `format`, not to UI components" (FR-001, FR-009).
- `format: openapi` (java-spring default) means the migrated view module produces an
  OpenAPI-style REST contract definition plus its backing endpoint/handler code.
- `alternates` permits a pack to *additionally* emit another machine-consumable schema
  (e.g. MCP tool schemas) without changing the primary default.
- Absence of `view_contract` in a pack that has no web output (e.g. the python pack today)
  is valid and means the pack declares no view-module mapping.

## Constraints

- This block is **data only**. No `migration/` runtime code reads it; it is consumed by
  prompts, skills, and pack instructions (Principle VII — stack knowledge stays in the pack).
- Values must respect the closed audit-template placeholder vocabulary only insofar as they
  appear inside templates; plain scalars/lists here are not interpolated.
- Changing `format` is a pack-level decision and does not touch core runtime.

## java-spring instance

```yaml
view_contract:
  format: openapi
  style: rest
  alternates: [mcp-tools]
  drop_rule: presentational
```
