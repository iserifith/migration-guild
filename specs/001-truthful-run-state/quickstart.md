# Quickstart: Truthful Run State

**Feature**: `001-truthful-run-state`

This document is the implementation and acceptance path for the feature. It validates the kit in a disposable or fixture workspace; it does not use a real migration source tree as a test fixture.

## Prerequisites

- Node.js 18+ and npm.
- Repository dependencies installed at the root, under `migration/`, and under `migration/ui/`.
- A fixture workspace with a registry and stack-pack configuration. Use fake provider and harness seams for automated tests; do not send test credentials or source to a live provider.
- For process-tree tests, the host must permit child-process creation. Windows-specific termination assertions run only on Windows; POSIX process-group assertions run on POSIX hosts.

## Install and baseline

From the repository root:

```bash
npm install
npm --prefix migration install
npm --prefix migration/ui install
npm --prefix migration run build
```

Confirm the pre-feature baseline before implementation work:

```bash
npm test
```

Record the baseline result in the implementation work log. A baseline failure must be diagnosed before attributing it to this feature.

## Test-first implementation order

Implement and test in this order, following the plan's dependency boundaries:

1. Registry schema and typed read/write contracts for verification and attempt outcomes.
2. Verification-state and bounded-scope tests, including the invariant that verification cannot satisfy arbitration evidence.
3. Environment loader and divergence/redaction tests.
4. Shared runtime-resolution and preflight tests using injected provider responses and a fake harness.
5. Effective-limit and honest close-out tests.
6. Process-tree termination tests with graceful, forced, confirmed, and survivor paths.
7. Portable context retrieval and packaged-agent guidance tests.
8. Status, review, documentation, and changelog integration tests.

Run the focused runtime suite from `migration/` while iterating:

```bash
npm --prefix migration test
```

Run the complete repository suite after each bounded implementation slice:

```bash
npm test
```

## Acceptance checks

### 1. Truthful artifact completion

Use a fixture whose tree-wide build cannot succeed while the claimed artifact's bounded output check can run.

Verify that:

- migration status and verification state are separate facts;
- verified, unverified, and verification-failed artifacts are visible from status;
- unrelated unmigrated artifacts do not block the claimed artifact;
- a budget timeout records `unverified` with its reason and still closes the claim;
- verification state alone cannot satisfy the independent arbitration gate.

### 2. Resolved preflight

Run the preflight contract against injected success, authorization failure, unknown-model, unreachable-provider, empty-response, and timeout cases. Also run offline mode.

Verify that:

- preflight and the runner use the same resolved harness/provider/model path;
- a successful adapter start without a model response is not a pass;
- failures identify the resolution, authorization, model-availability, or response stage;
- live checks are bounded to 30 seconds by default;
- offline output is `unvalidated`, never plain `pass`;
- credential values are never printed.

### 3. Environment precedence

Set one non-secret value to different values in the project-local `.env` and the inherited environment.

Verify that:

- without opt-in, the project-local value wins;
- with explicit ambient opt-in, the inherited value wins;
- both values and the winning source are reported for non-secret variables;
- secret values are redacted while the variable name and winner remain visible;
- the resolved provider and model are reported at every phase start.

### 4. Limits and honest outcomes

Run a phase with a deliberately short per-phase limit and inspect both the pre-run limit report and the termination summary.

Verify that:

- the named knob is the knob that actually governed the termination;
- the effective value, source, precedence, and any applied floor are visible;
- the summary states files written, status transition, claim disposition, cleanup result, terminal reason, and consumed budget;
- no-progress termination is not labelled as success;
- repeated no-progress attempts are queryable by artifact.

### 5. Process-tree cleanup

Use a fixture adapter that starts a long-lived child or grandchild, including one that ignores graceful termination.

Verify that:

- graceful termination is attempted first;
- forced termination follows after the bounded grace period;
- no process started by the attempt remains after confirmation;
- any survivor is named as a cleanup failure;
- claim release is reported together with process-cleanup outcome.

### 6. Portable context retrieval

Create a context record with a missing or foreign-platform path and a non-empty stored summary.

Verify that:

- an existing file is returned as `form: file`;
- an unavailable file falls back to the stored summary as `form: summary`;
- separators and canonical layout are handled without caller-side path repair;
- absent file and empty summary return an explicit `form: none` response;
- packaged agent guidance consumes the returned response directly.

## Final quality gate

From the repository root:

```bash
npm test
npm run build
```

Then inspect the feature artifacts against the constitution and confirm:

- no migration status values or pipeline phase were added;
- no write authorization was broadened;
- verification remains separate from independent arbitration evidence;
- project-local `.env` precedence and ambient opt-in are documented;
- all secrets in test output, reports, and recorded evidence are redacted;
- the generated implementation tasks remain bounded to this feature and do not include #43, #48, or #51.
