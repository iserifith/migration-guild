---
description: "Context for working with legacy Java source files in the legacy/ directory. Applies when reading or analyzing old Java code scheduled for migration."
applyTo: "legacy/**/*.java"
---

This file belongs to the **legacy** codebase and is scheduled for migration. Read it to understand the behavior to replicate — then write the migrated version to `modern/`.

## Rules for this file

- Read-only: do not modify or add features to this file
- Do not fix bugs here — migrate the file to `modern/` instead
- Never copy legacy framework imports into the migrated code
- When reading for migration purposes, note every:
  - Framework-specific annotation (e.g. `@Path`, `@Stateless`, `@Action`, `@RemoteInterface`)
  - XML config dependency (`web.xml`, `ejb-jar.xml`, `applicationContext.xml`, `struts.xml`)
  - JNDI lookup
  - Hardcoded URL, port, or credential string
  - Blocking / synchronous pattern that may need async handling in the target
