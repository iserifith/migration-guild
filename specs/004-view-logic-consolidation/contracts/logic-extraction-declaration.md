# Contract: `logic_extraction` stack-pack declaration

**Audience**: stack-pack authors; migration agents reading pack instructions.

A stack pack whose mapping rules cover legacy view-handling modules declares its
dedicated-module naming vocabulary in `stack.yaml`, sibling to `view_contract:`.

## Schema

```yaml
logic_extraction:
  service_suffix: Service          # required: business-logic module name suffix
  validator_suffix: Validator      # required: validation module name suffix
  handler_roles: [rest-endpoint]   # required: registry roles whose handlers bind + delegate only
```

## Semantics

1. **Consolidation target.** Business logic extracted from a migrated view-handling module
   lands in a module named `*<service_suffix>`; validation logic in `*<validator_suffix>`.
   These modules are invoked by one or more contract-backed handlers.
2. **Handler scope.** Migrated artifacts classified under `handler_roles` contain only
   contract-binding and delegation code: routing, parameter binding, invoking the
   service/validator, response shaping.
3. **Deduplication.** A rule shared across multiple endpoints lives in exactly one module.
4. **Trivial pass-through exemption.** A view module carrying no validation or business
   rules beyond delegation does not require an empty dedicated module.
5. **Inert when absent.** A pack without this block declares no consolidation convention;
   placement rules are inert for that pack.

## Consumers

- `mappings.md` placement subsection — normative mapping rule text.
- `audit.rules.yaml` `view-logic-placement-*` rules — recognition patterns derived from the
  declared suffixes/handler vocabulary.
- `migration-review` SKILL.md checklist / `review-agent` — the reviewer's placement
  verification item.
- `post-migration-audit` prompt / `audit-agent` — the holistic `modern/`-tree placement scan.

## java-spring instance

```yaml
logic_extraction:
  service_suffix: Service
  validator_suffix: Validator
  handler_roles: [rest-endpoint]
```
