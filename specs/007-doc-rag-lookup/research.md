# Phase 0 Research: Version-Locked Documentation RAG for Codegen

Each item resolves one open question from `spec.md`'s Technical Context, grounded
against the actual repository rather than assumed.

## 1. Locked dependency set input is real, not speculative

**Decision**: Ingestion (User Story 3) consumes `getLockedDependencySet(db)` from
`migration/registry/commands/dispositions.ts` directly, filtering to rows where
`disposition === 'keep'` (per FR-005 — only kept libraries have a locked version
to index against).

**Rationale**: Spec 006 (Planner-Emitted Dependency Disposition Records) is fully
implemented, not partially built as `spec.md`'s original Assumptions section
stated (corrected during this planning pass — see spec.md's Assumptions
correction note). `dispositions.ts` exports `upsertProposedDisposition`,
`confirmDisposition`, `listDispositions`, `getLockedDependencySet`, and
`dispositionContextForArtifact`, all covered by `migration/test/disposition-*.test.ts`.
`migration/registry/cli.ts:1044-1047` already exposes `locked-dependency-set` as
a CLI command, with a docstring that explicitly names this feature as its
consumer. `LockedDependencySetEntry` rows carry exactly what ingestion needs:
`library_name`, `disposition`, `locked_target_version`, `native_replacement`,
`inline_note`, `confirmed_by`, `confirmed_at`.

**Alternatives considered**: Treating the locked set as unavailable and building
a standalone dependency-discovery step for this feature — rejected as duplicate
work once the real function was found; would also violate the single-source-of-truth
intent of spec 006.

## 2. Second SQLite database, not new registry tables

**Decision**: `.guild/index.db` is a second `better-sqlite3` database, opened
the same way `migration/registry/db/connection.ts` opens `registry.db`: WAL
mode, `foreign_keys = ON`, `busy_timeout`, schema auto-applied on first open. A
new `resolveIndexDbPath()` mirrors `resolveRegistryDbPath()` in
`migration/guildctl/config.ts` — default `.guild/index.db`, resolved against
workspace root, overridable via config the same way `database.path` is today.

**Rationale**: `spec.md`'s Assumptions already committed to this (bulk reference
documentation vs. workflow/decision state); grounding confirms the exact
pattern to mirror. `resolveRegistryDbPath` already resolves `.guild/registry.db`
against a workspace root found by walking up for a `.guild/` directory
(`config.ts:116`) — `.guild/index.db` is a sibling file in that same directory,
no new directory-discovery logic needed.

**Alternatives considered**: New tables in `registry.db` — rejected per
`spec.md`'s existing Assumption (bulk reference content vs. workflow state,
and no need for `registry.db`'s claim/lease/evidence machinery to apply to
static documentation rows).

## 3. FTS5 availability — confirmed, no action needed

**Decision**: Use SQLite's native `FTS5` virtual table for the search index
(FR-001/FR-002a). No additional native module or runtime extension loading.

**Rationale**: Already verified prior to this planning session — `better-sqlite3`
is pinned at `12.8.0` in `migration/package.json`, and that version's bundled
SQLite amalgamation is compiled with `SQLITE_ENABLE_FTS5` (confirmed against
the tagged upstream `deps/defines.gypi`). Restated here because Phase 0 is
where such platform facts belong; no new verification was needed.

## 4. Ingestion is a harness-driven agent, not a deterministic scraper

**Decision**: A new agent persona (`doc-ingestion-agent`, alongside
`code-writer-agent`, `review-agent`, etc. under `package/agents/`) runs through
the existing harness/CLI-adapter layer (`migration/guildctl/harness.ts`),
launched the same way `runner.ts:423` launches every other agent
(`--agent <name> --model <model> --yolo -p <prompt>`), using its harness CLI's
own native web-fetch/browsing tools to gather source material per locked
library.

**Rationale**: Resolved during `/speckit-clarify` (see spec.md Clarifications).
Confirmed buildable: `runner.ts` already passes `--yolo` (not `--read-only`)
for every agent launch, which the `opencode.mjs` adapter maps to
`permission: "allow"` with no per-tool restriction
(`opencode.mjs:writeProviderConfig`) — so no adapter code change is required
to let a new persona use built-in web tools once launched this way.

**Alternatives considered**: A bespoke Maven-artifact-classifier
scraper (fetch `-sources.jar`/`-javadoc.jar`/plain jar by GAV coordinate,
parse locally) — considered and set aside during clarification in favor of the
agent-driven approach to match how every other phase in this codebase already
works (Migrate, Critic, Planner are all agents, not scripts); may still be
revisited as a lower-cost v2 addition for one ecosystem if agent-driven
ingestion proves unreliable for common cases, but is out of v1 scope.

## 5. Which harness runs the ingestion agent — pinned to opencode for v1

**Decision**: The ingestion agent's harness is a dedicated config setting
(`ingestion.harness`, default `"opencode"`), independent of the workspace's
primary `harness` setting used for Migrate/Critic/Planner. v1 does not inherit
`config.harness` for this agent. **`env.AGENT_CMD` still overrides this the
same way it overrides every other agent dispatch** — ingestion resolves its
harness through the existing `resolveHarness(config, root, env)` in
`harness.ts`, called with an effective config whose `harness` field is
`config.ingestion.harness` instead of `config.harness`, not a separate
resolution path. `resolveHarness()` already checks `env.AGENT_CMD` first,
before consulting `config.harness` (`harness.ts:20-22`), so this preserves
Constitution Principle VII's "`AGENT_CMD` as the escape hatch for custom
binaries" (`constitution.md:157`) for ingestion exactly as it does for every
other agent — an operator running a custom harness binary is never silently
downgraded to `opencode` for ingestion specifically.

**Rationale**: FR-014a requires the ingestion agent to use its harness's
*already-existing* native web tools rather than the feature building its own.
That requirement is only actually satisfiable today for one of the three
primary harnesses without additional work:
- **opencode** — confirmed via its published tool reference: ships `webfetch`
  and `websearch` as built-in tools, "enabled by default... work with custom
  OpenAI-compatible providers" — exactly this project's provider setup
  (`AGENT_PROVIDER_BASE_URL` / `AGENT_PROVIDER_API_KEY_ENV`). No MCP, no extra
  config beyond permissions, which `--yolo` already grants.
- **goose** — MCP-extension-capable (confirmed earlier in spec work), but no
  confirmed *native* (non-MCP) browsing tool; likely needs an MCP fetch
  extension configured, which reintroduces exactly the "build a browsing tool"
  work FR-014a set out to avoid.
- **codex** — MCP-client-capable (confirmed earlier), but any native web-search
  tool is documented as tied to OpenAI-hosted ChatGPT-connected accounts, not
  confirmed available through a custom OpenAI-compatible provider (this
  project's `codex.mjs` adapter routes through `model_providers.migration_guild`,
  not an OpenAI-hosted account) — unconfirmed and likely unavailable as-is.

Pinning ingestion to `opencode` (which is also already this project's
*default* harness — `config.ts:38` — so this is the harness most workspaces
already have installed) gives FR-014a a mechanism confirmed to work today,
without blocking on further verification of goose/codex. Per Constitution
Principle VI (Fail-Closed Automation), if `opencode` is not installed/reachable
in an environment (checked via the existing `checkHarness()` preflight
pattern), ingestion fails closed with a clear message rather than silently
falling back to a harness whose native web-tool support is unverified.

**Alternatives considered**: Inheriting `config.harness` unconditionally —
rejected because it would silently degrade to an unverified (goose) or
likely-nonfunctional (codex) web-tool path for workspaces that configured a
different primary harness, which is exactly the kind of "guess past an
unexplained failure" Principle VI forbids. Building an MCP-based
`fetch_url` tool to make all harnesses uniform — rejected during
`/speckit-clarify` (FR-009's MCP server is scoped to index-query tools only).

**Follow-up (not blocking v1)**: verifying goose/codex native or
easily-added web-tool support is worth a future spike so `ingestion.harness`
isn't permanently a one-harness feature; tracked as a task-level note, not a
spec change.

## 6. Ingestion trigger — explicit operator command, not automatic

**Decision**: Ingestion runs via an explicit new command
(`registry ingest-docs`, mirroring the `locked-dependency-set` /
`confirm-disposition` command style already in `migration/registry/cli.ts`),
not automatically fired at the end of Plan/disposition-confirmation.

**Rationale**: `spec.md`'s User Story 3 already frames this as "an operator
wants to run an ingestion step," and this matches the constitution's
Fail-Closed Automation posture: ingestion touches the network (agent browsing)
and can take real wall-clock time (SC-004: up to 10 minutes for 20 libraries)
— an operator-invoked step keeps that cost visible and deliberate rather than
silently tacked onto the end of every Plan run, mirroring why disposition
*confirmation* itself (spec 006) is a distinct, operator-gated step rather than
automatic. A `--auto-ingest` flag on the Plan command is a reasonable v2
convenience but is not required by any FR in `spec.md` and is left out of v1
scope to keep this planning pass matched to what was actually specified.

**Alternatives considered**: Auto-run ingestion as part of `runPlan` after
disposition confirmation — rejected for v1 as unspecified scope creep beyond
`spec.md`'s FRs, and because it would make an unattended Plan run's duration
and network footprint unpredictable.

## 7. Library identity format — Maven GAV coordinates, Java/Maven-only for v1

**Decision**: `library_name` in the documentation index uses the same
`groupId:artifactId` format already used by `dependency_dispositions.library_name`
and by stack-pack `library_prefixes`/`native_equivalents` maps (confirmed in
`stacks/java-spring/classification.yaml`, e.g. `"com.google.guava:guava"`). v1
ingestion covers the Java/Maven ecosystem only — consistent with `spec.md`'s
existing Assumption that FR-014's pluggability is about not hard-coding a
single source, not about shipping every ecosystem on day one, and consistent
with this being the only stack pack currently shipped (`stacks/java-spring`).

**Rationale**: Reusing the exact identity format the locked dependency set
already produces means no translation/mapping layer is needed between spec
006's output and spec 007's input.

**Alternatives considered**: A synthetic cross-ecosystem identity scheme
(e.g., PURL) — unnecessary complexity for a single-ecosystem v1; deferred
to whenever a second stack pack is added.

## 8. Documentation entry granularity and disambiguation

**Decision**: One `documentation_entries` row per (library, version, symbol,
full signature) — class-level entries carry `symbol_kind='class'` with no
parameter list; method-level entries carry `symbol_kind='method'` plus a
normalized parameter-type signature string, satisfying FR-011's overload
disambiguation.

**Rationale**: Directly satisfies FR-011 (disambiguate overloads by full
signature, not method name alone) and keeps exact-match lookup (FR-002) a
single indexed-key read.

**Alternatives considered**: One row per class with all methods embedded as a
JSON blob — rejected: defeats FR-011's per-overload disambiguation and makes
FR-015's chunking harder to do precisely (would have to sub-chunk inside a row
instead of returning a bounded number of matching rows).
