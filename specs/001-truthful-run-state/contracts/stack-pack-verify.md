# Contract: Stack Pack `verify:` Block

**Interface**: `stack.yaml` — the stack-pack manifest. **Locations**: `stacks/<id>/stack.yaml` and
the shipped copy `package/stacks/<id>/stack.yaml`, which must be byte-identical after the pre-existing
Python-pack difference is reconciled by T069 and must stay so thereafter.

**Why this is a contract and not core code**: Constitution VII requires stack-specific knowledge —
classification heuristics, framework mappings, audit rules, scaffold templates — to live in stack
packs, not in core runtime. A per-unit compile or test invocation is exactly that kind of knowledge:
`./gradlew compileJava` is meaningless to the Python pack. Core reads this block as **data** and
executes it; core contains no build or test command for any stack.

**Status**: NEW, and **optional**. A stack pack without a `verify:` block is valid; artifacts under
it record `unverified` with reason `no-stack-check`. This keeps every existing workspace working
unchanged.

---

## Schema

```yaml
verify:
  # Optional. When absent → verification records unverified/no-stack-check.
  per_artifact:
    id: gradle-compile           # recorded as artifact_verifications.method
    cmd: ./gradlew               # executable; resolved from the workspace root
    args: ["compileJava", "--offline", "-PincludePaths={output_paths}"]
    availability_args: ["--version"]   # probe; when it fails → unverified/no-stack-check
    # working_dir: .              # optional; relative to workspace root; omitted means workspace root
    budget_seconds: 120          # optional per-stack override of verification.budget_seconds
    pass_exit_codes: [0]         # optional; defaults to [0]
    unavailable_note: >          # operator-facing text when availability_args fails
      No Gradle wrapper found under modern/; per-artifact verification was skipped.
```

This mirrors the shape `audit.external_probes` already uses in both shipped packs (`cmd`,
`availability_args`, `args`, `targets`, `available_note`, `fallback_note`), so pack authors meet a
familiar structure rather than a new one.

---

## Placeholders

Substituted into `args` and, when supplied, `working_dir` before execution. Every value is derived from
**registry rows**, never from a filesystem scan. If `working_dir` is omitted, execution uses the
workspace root. The shipped packs intentionally omit it because their path placeholders are already
workspace-root-relative.

| Placeholder | Expands to |
|-------------|-----------|
| `{artifact_path}` | the claimed artifact's own path |
| `{output_paths}` | the claim's recorded `expected_output_paths`, space-joined |
| `{dependency_paths}` | output paths of one-hop declared dependencies, space-joined |
| `{scope_paths}` | `{output_paths}` + `{dependency_paths}` — the full Verification Scope |
| `{module}` | the artifact's `module`, or empty |
| `{workspace_root}` | absolute workspace root |

Placeholder values are passed as **discrete argv entries**, never through a shell. A value containing
a space, quote, or shell metacharacter cannot alter the command.

---

## Execution rules (enforced by core)

| Rule | Requirement |
|------|-------------|
| **Scope** (FR-003) | The command receives only the Verification Scope: the claimed artifact's own outputs plus one hop of declared dependencies. A pack MUST NOT be able to request a tree-wide build; there is no `{all_artifacts}` placeholder, by design. |
| **Containment** (FR-005) | `working_dir` and every substituted path are asserted inside the workspace root via `isPathInside` before the command is built. A path resolving outside aborts the check with `verification-failed` / `check-error`. |
| **No searching** (FR-005) | Core performs no filesystem globbing to build the invocation. Placeholders come from registry rows only. |
| **Budget** (FR-004) | Bounded by `budget_seconds` if present, else `verification.budget_seconds` (default 120). On elapse the check's **process group** is terminated using the same mechanism as agent termination, and the record is `unverified` / `budget-exhausted`. |
| **Environment** | Runs with `scrubVerificationEnv()` — the existing allow-list that strips credentials from verification subprocesses. The check never receives a provider credential. |
| **No shell** | `spawn` with `shell: false`. |
| **Availability** | `availability_args` is probed first. Failure → `unverified` / `no-stack-check` with `unavailable_note` shown, **not** `verification-failed`. A missing toolchain is not a failed verification. |
| **Never blocks** | No outcome of this check blocks the artifact from advancing (FR-006). The check informs the record; it does not gate the status transition. |

**Toolchain provisioning is out of scope.** The spec excludes guaranteeing toolchain presence in
agent environments; `availability_args` + `unavailable_note` is how a missing toolchain is reported
honestly rather than provisioned.

---

## Outcome mapping

| Situation | `state` | `reason` |
|-----------|---------|----------|
| exit code in `pass_exit_codes` | `verified` | — |
| exit code outside `pass_exit_codes` | `verification-failed` | `check-failed` |
| command could not execute; path escape; malformed template | `verification-failed` | `check-error` |
| `availability_args` failed, or no `verify:` block | `unverified` | `no-stack-check` |
| budget elapsed | `unverified` | `budget-exhausted` |
| a one-hop dependency is not yet migrated | `unverified` | `tree-incomplete` |

`method` is set to `per_artifact.id`. `scope_json` records the paths actually covered, so a
`verified` record can always say what it verified.

---

## Shipped packs

Both packs gain a `verify:` block using their existing declared conventions — `java-spring` already
declares `test_framework: junit5` and Gradle scaffold templates; `python` declares its own. The
concrete commands are a stack-pack authoring decision made during implementation, constrained by the
rules above. Whatever they are, they must:

- act on `{scope_paths}` or `{output_paths}`, never on the whole tree;
- declare `availability_args` so a workspace without the toolchain degrades to `no-stack-check`;
- be added identically to `stacks/<id>/stack.yaml` **and** `package/stacks/<id>/stack.yaml`.
