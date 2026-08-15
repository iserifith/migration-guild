# Quickstart: Validating Agent-First Migration Output

Runnable validation scenarios proving the feature end-to-end. These run in a **fresh migration
workspace outside this repository** (constitution: this repo is the kit, not a workspace) —
use `package/mock/` or operator-supplied legacy code. Kit-level rule behavior is covered by
`npm test` in this repo.

## Prerequisites

- This repo built: `npm install && npm run build` (or the repo's documented build).
- A scratch workspace: `mkdir /tmp/viewcheck && cd /tmp/viewcheck`.
- A stack config selecting `java-spring` (`.guild/config.yaml`: `stack: java-spring`).

## Scenario 1 — Legacy view file enters the registry (FR-001 groundwork)

```bash
mkdir -p legacy/src/main/webapp
cat > legacy/src/main/webapp/user.jsp <<'EOF'
<%@ page contentType="text/html" %>
<html><body>${user.name}</body></html>
EOF
node migration/registry/dist/cli.js --help >/dev/null  # registry CLI present
# run inventory scan (scanAndRegister) against the workspace
```

**Expected**: `user.jsp` is registered as a `legacy-source` artifact (the widened
`source_globs` include `**/*.jsp`), classified framework `jsp`. It is visible in
`list-artifacts` — not silently ignored.

## Scenario 2 — Audit catches regenerated view UI in output (FR-005, SC-003)

Register a `modern/`-bound artifact (or run the post-migration audit prompt) against a tree
containing a regenerated view:

```bash
mkdir -p modern/src/main/webapp
cp legacy/src/main/webapp/user.jsp modern/src/main/webapp/user.jsp   # the violation
# run the audit (refreshCompatibilityAudits / audit-agent / post-migration-audit prompt)
```

**Expected**: a `critical` finding with `category: view-regeneration` naming
`modern/src/main/webapp/user.jsp`, the rule id (`view-regeneration-jsp`), and a remediation
directing replacement by the API contract output. The finding appears in the standard
findings report alongside existing audit findings.

## Scenario 3 — Clean contract output produces no false positives (SC-003)

```bash
rm -rf modern && mkdir -p modern/src/main/java/com/example/migrated
cat > modern/src/main/java/com/example/migrated/UserController.java <<'EOF'
package com.example.migrated;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/users")
public class UserController { /* behavior preserved, no view UI */ }
EOF
# run the audit
```

**Expected**: zero `view-regeneration` findings. The legitimate contract-backed controller
matches none of the `view-regeneration-*` rules.

## Scenario 4 — Purely-presentational view records an intentional drop (FR-004)

```bash
cat > legacy/src/main/webapp/layout.jsp <<'EOF'
<%@ page %><html><body>static shell, no logic</body></html>
EOF
# classify + plan: no extractable routing/validation/business behavior
```

**Expected**: `layout.jsp` is **not** regenerated. Its artifact reaches `status: skipped`
with the `view-dropped-presentational` tag and an event stating the reason — listable via
`list-artifacts --status skipped`, i.e. the drop is visible in migration state.

## Scenario 5 — Review checklist flags regenerated UI (FR-007, SC-004)

```bash
# Reintroduce the violation from Scenario 2, then run the migration-review skill
# (or review-agent) on the migrated view module
```

**Expected**: the checklist's view-module section directs the reviewer to confirm (a) an API
contract was produced, (b) routing/validation behavior was preserved, (c) no view-layer UI
was regenerated. The regenerated `user.jsp` is reported as a finding, not approved.

## Kit-level regression (this repo)

```bash
npm test
```

**Expected**: `migration/test/audit-view-regeneration.test.ts` passes — positive detection
(Scenario 2 shape), negative/clean detection (Scenario 3 shape), and `.jsp` registration
(Scenario 1 shape) — and `migration/test/stack-pack-engine.test.ts` reflects the updated
java-spring rule count.

## References

- Contract format declaration: [contracts/stack-view-contract.md](./contracts/stack-view-contract.md)
- Audit rule shapes: [contracts/audit-view-regeneration-rules.md](./contracts/audit-view-regeneration-rules.md)
- Entities and state: [data-model.md](./data-model.md)
