---
description: "Context for working with migrated Java source files in the modern/ directory. Applies when writing or editing code in the migration target module."
applyTo: "modern/**/*.java"
---

This file belongs to the **target** (migrated) codebase. This is where migrated code lives.

## Rules when working here

- Do **not** introduce source-framework imports or annotations
- Do **not** reference XML configuration from the legacy system (`web.xml`, `ejb-jar.xml`, etc.)
- Prefer tests-first migration: write or update target-side tests before production code when behavior is observable
- All configuration values must use the target framework's property injection mechanism — no hardcoded strings, URLs, or ports
- New string literals → place in a shared constants class if one exists in this codebase
- DI must use the target framework's annotations consistently — match the pattern already used in this module
- Tests must use the target test framework — do not mix legacy and target test annotations
- Security: use `org.owasp.encoder.Encode` for any user-provided content rendered in output
- Before writing a new file, read an existing file in the same sub-package to confirm conventions
- Always check the registry before starting work — use `claim` to avoid duplicate work across sessions
