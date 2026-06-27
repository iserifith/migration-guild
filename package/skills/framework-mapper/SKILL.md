---
name: framework-mapper
description: "Translate common legacy Java framework constructs into target framework patterns. Use for converting JAX-RS resources, servlets, filters, EJBs, XML config, exception handlers, and old tests into modern equivalents."
argument-hint: "Describe the legacy pattern or provide a legacy file path"
---

# Framework Mapper

Use this skill when the legacy framework has been identified and you need the concrete replacement pattern for the target framework.

## When to Use

- You know the source framework but need the right target idiom.
- You need a mapping from XML config or JNDI-based config to modern properties and Java config.
- You need to decide whether a legacy class should become a controller, service, config, filter, advice class, or plain component.

## Procedure

1. Identify the legacy construct to replace.
2. Use the active stack pack mappings injected into the planning prompt and find the nearest target equivalent.
3. Check the workspace for an existing reference example if one exists.
4. Prefer the workspace example over generic guidance when the patterns are materially similar.
5. If no example exists, use standard conventions for the target framework.
6. Record any uncertainty as an assumption instead of blocking.

## Mapping Rules

- XML config should become Java config or properties-based wiring.
- JNDI lookups should become property injection or framework-managed beans.
- Legacy exception mappers should become the target framework's equivalent exception handling mechanism.
- Legacy tests should become JUnit 5 tests, using framework test slices only when needed.

## Output Checklist

- Source construct is named.
- Target pattern is named.
- Required annotations are listed.
- Config migration notes are listed.
- Test implications are listed.
