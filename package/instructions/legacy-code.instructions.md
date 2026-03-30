---
description: "Context for working with legacy Java source files in the legacy/ directory. Applies when reading or analyzing old Java code scheduled for migration."
applyTo: "legacy/**/*.java"
---

This file belongs to the **legacy** codebase. It is scheduled for migration to the target framework. Treat it as **read-only** reference material.

## Rules when working here

- Do **not** add new features or modify legacy classes
- Do **not** fix bugs in legacy unless explicitly asked — migrate the file instead
- Never copy legacy framework imports into the target codebase
- When reading for migration purposes, note every:
  - Framework-specific annotation (e.g. `@Path`, `@Stateless`, `@Action`, `@RemoteInterface`)
  - XML config dependency (`web.xml`, `ejb-jar.xml`, `applicationContext.xml`, `struts.xml`)
  - JNDI lookup
  - Hardcoded URL, port, or credential string
  - Blocking / synchronous pattern that may need async handling in the target
