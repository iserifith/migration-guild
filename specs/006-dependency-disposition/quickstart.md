# Quickstart: Validating Planner-Emitted Dependency Dispositions

**Feature**: `006-dependency-disposition` | **Date**: 2026-08-16

Runnable validation scenarios proving the feature end-to-end. Per the
constitution, kit behavior is validated in a fresh workspace OUTSIDE this
repository using `package/mock/` sample content — never against the repo root.

## Prerequisites

- Kit built: `npm run build` (compiles `migration/registry/dist/cli.js` and
  `migration/guildctl/dist/cli.js`).
- A scratch workspace: `mkdir /tmp/disp-ws && cd /tmp/disp-ws`, bootstrapped per
  `GETTING-STARTED.md`, with a small legacy Java project containing:
  - a `pom.xml` declaring at least three third-party libraries:
    1. one with a pack-seeded native equivalent (e.g. `joda-time:joda-time`),
    2. one small helper library used only for a few utility methods
       (e.g. commons-lang3 with only `StringUtils` imports),
    3. one library with no native equivalent (e.g. `jackson-databind`);
  - source files importing (1) and (2), plus one declared-but-unused library.
- `stacks/java-spring/classification.yaml` carrying the new `dependencies:` block
  (see contracts/disposition-pack-yaml.md).

## Scenario 1 — Collector proposes one record per library (US1, FR-001/FR-012)

```bash
node migration/guildctl/dist/cli.js inventory   # registers artifacts + findings
GUILDCTL_AUTO_KEEP_SCOPE=1 GUILDCTL_AUTO_CONFIRM_MAPPINGS=1 \
GUILDCTL_AUTO_APPROVE_DEPENDENCIES=1 GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1 \
  node migration/guildctl/dist/cli.js plan
node migration/registry/dist/cli.js list-dispositions
```

Expected: one disposition row per manifest-declared library (including the
declared-but-unused one, whose row carries a `scan_notes`/`usage_json` note that
no usage was found). Joda-Time's proposal is `replace-with-native` → `java.time`
(from the pack seed); the library with no equivalent proposes `keep` — never an
invented replacement (spec edge case #2).

## Scenario 2 — Interactive confirmation with override (US2, FR-005)

```bash
node migration/guildctl/dist/cli.js plan    # TTY, auto-confirm vars unset
```

Expected: after the Planner phase, each pending proposal is presented with its
usage summary. Answering `e` on the replace-with-native proposal and changing it
to `keep` records the override: `list-dispositions` shows `keep`,
`confirmed_by=operator`, and `dependency_disposition_history` contains a
`change_kind='override'` snapshot of the prior proposal.

## Scenario 3 — Unattended run without auto-confirm is fail-closed (FR-006/FR-007)

```bash
node migration/guildctl/dist/cli.js plan < /dev/null    # non-interactive, env unset
```

Expected: a silence-first warning that N dispositions are pending; planning
completes wave assignment but the end-of-Plan readiness gate reports "Planning
blocked by unconfirmed dependency dispositions" with the
`list-dispositions --status proposed` remediation command. No library is
silently defaulted.

## Scenario 4 — Re-run never silently overwrites confirmed decisions (FR-011)

1. Confirm joda-time as `keep` (override).
2. Re-run `plan`. The collector's fresh evidence (native-equivalent seed) still
   suggests replace-with-native.
3. Expected: the confirmed `keep` row is untouched; `pending_disposition` is set
   with the new proposal and `list-dispositions --pending-only` shows it;
   readiness counts the row unresolved until the pending proposal is confirmed
   or rejected. `getLockedDependencySet` still reports `keep` — the current
   confirmed decision remains in effect.

## Scenario 5 — Locked dependency set is deterministic and doc-RAG-ready (FR-008/FR-009, SC-004)

```bash
node migration/registry/dist/cli.js locked-dependency-set
node migration/registry/dist/cli.js locked-dependency-set | sha256sum   # twice
```

Expected: identical output across invocations (ORDER BY library_name); every
`keep` entry carries a non-null `locked_target_version`; replaced entries name
their native target; inlined entries are flagged with their inline note.
Resolution completes well under 5s at 500 libraries (single indexed scan).

## Scenario 6 — Migration agents see pruned-library guidance (US3, FR-010)

```bash
node migration/registry/dist/cli.js confirm-disposition --library joda-time:joda-time --confirmed-by operator   # accept replace-with-native
node migration/guildctl/dist/cli.js migrate --wave 1
```

Expected: code-writer pool sessions for artifacts using joda-time receive prompt
text naming the native replacement ("do not re-declare joda-time; use
java.time"), derived from `dispositionContextForArtifact`. Artifacts with only
kept libraries receive no suffix.

## Regression coverage this quickstart maps to

`tasks.md` must sequence `migration/test/*.test.ts` coverage ahead of/alongside
implementation (Constitution §V — this feature changes phase control flow and a
readiness gate):

- schema: new tables exist with expected columns/CHECKs (mirror
  `registry-schema-delta.test.ts`'s approach);
- collector: universe = findings ∪ manifest declarations, incl. unused library;
- upsert semantics: propose → refine → confirm → re-propose (pending) →
  fold-on-confirm, incl. history snapshots per transition;
- validation: replace-with-native without target, inline without note, keep
  confirmed without locked version all rejected;
- readiness: unconfirmed/pending rows block; confirmed non-keep dispositions
  resolve matching dependency findings;
- auto-confirm: env-var path records `benchmark-runner` as confirming actor;
- locked set: determinism, confirmed-only membership, pending rows contribute
  current decision.
