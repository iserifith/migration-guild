# Bootstrap, Onboarding Wizard & Kit Packaging — Deep Dive

*Cartographer module map. Everything below is grounded in code on `origin/main` (@ `d5512f0`); spec files `specs/009-workspace-scaffolding-entry-points/` and `specs/012-onboarding-wave6-kit-packaging/` are cited as intent sources (they live on `origin/dev` history, e.g. commit `8b9dabe` and `249351b`).*

---

## 1. Overview

"Getting a new workspace" happens in three distinct layers, owned by three different pieces of code:

1. **Kit packaging** — `scripts/build-dist.mjs:assembleTarball()` turns the repo into a self-contained `dist/migration-guild-kit.tar.gz`. The `package/` directory is the shipped source of truth for agents/skills/prompts/instructions/harnesses/mock fixtures.
2. **Onboarding wizard** — root `setup.ts` (compiled to `setup.js` by tsup, see `package.json:scripts.build`) is the first thing a kit consumer runs. It copies kit files into a fresh workspace directory, optionally clones/copies legacy source into `legacy/`, and renders one template variable (`{{TARGET_FRAMEWORK}}`).
3. **Workspace bootstrap** — `migration/guildctl/commands/bootstrap.ts` scaffolds the *modern target module* (`modern/` Gradle project) from the active stack pack's templates. This runs inside the pipeline (`guildctl run bootstrap` phase, or implicitly before `migrate`).

The two "bootstrap" meanings must not be conflated: `setup.ts` bootstraps the *workspace envelope*; `commands/bootstrap.ts` bootstraps the *modern code skeleton*. Spec 009 governs the former's entry points; spec 012 governs tarball integrity and first-run guidance.

---

## 2. Flow walkthrough

### 2.1 Building the kit (maintainer side)

Entry: `npm run build:dist` → `scripts/build-dist.mjs:main()`:

1. **Step 1** — `main()` runs `npm install` + `npx tsup` inside `migration/` (build-dist.mjs Step 1 comment, FR-004 of spec 012). This is deliberate: a fresh clone only ran the *root* `npm install`, so the nested installs are the build script's job.
2. **Step 2** — builds root `setup.ts` → `dist/setup.js` via `npm run build` (tsup, per `package.json`).
3. **Step 3** — installs `migration/ui/node_modules` and builds the Mission Control UI into `migration/ui-dist` (the location `registry/commands/serve.ts`'s `UI_DIR` expects).
4. **Step 4** — `assembleTarball()` stages and tars:
   - `setup.js`, `README.md`, `GETTING-STARTED.md`, `AGENTS.md` copied verbatim.
   - repo-root `docs/` copied **only if it exists** (ENOENT-skip precedent, spec 009 FR-001–FR-004).
   - `package/` → `buildDir/package/` through `copyFilteredDirectory()` + `shouldCopyPackageEntry()`, which filters out `node_modules`, any `.env` file, top-level `legacy/`/`modern/`/`migration/` content, and raw `.ts` sources.
   - `package/.env.example` re-copied explicitly with ENOENT tolerance.
   - Prebuilt trees: `migration/registry/dist`, `migration/guildctl/dist`, `migration/ui-dist`, root `stacks/`.
   - **Spec-012 fix**: `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` are copied verbatim so the documented `cd migration && npm install` works from the tarball alone and `registry/db/schema.ts`'s walk-up lookup finds the schema.
   - Empty `package/legacy/` and `package/modern/` (with `modern/.gitkeep`) are created as placeholder dirs.
   - Finally `tar -czf dist/migration-guild-kit.tar.gz`.

### 2.2 First-run wizard (consumer side)

Entry: `node setup.js` in an empty workspace dir → `setup.ts:main()`.

- **Guard**: `main()` refuses to run if `package/agent-instructions.md` exists under CWD — i.e. you're inside the kit source tree, not a workspace (`setup.ts:main`, kitRootMarker check).
- **Mode select**: `--update` → `runUpdate()`, else `runInstall()`.
- **`runInstall()`** (`setup.ts:runInstall`):
  - Flag parsing (`--framework`, `--legacy-url`, `--legacy-path`, `--yes`) at `setup.ts` CLI-flag block. Non-interactive mode triggers when `--yes` is present or `--framework` plus a legacy source is given.
  - Interactive branch prompts: framework menu (5 Java targets, default Spring Boot 3.x) then legacy repo URL (blank = skip).
  - Copies `GITHUB_MAPPINGS` (`agents`, `skills`, `prompts`, `instructions` → `.github/<folder>/`) and `ROOT_MAPPINGS` (`legacy`, `modern`, `tools`→`migration/`, `harness`, `stacks`) via `copyDir()`.
  - Renders `.github/agent-instructions.md` from `package/agent-instructions.md`, substituting `{{TARGET_FRAMEWORK}}`.
  - Copies `.env.example`, `guildctl.config.json`, `agent-shim.mjs` to workspace root — but only if not already present.
  - Legacy source: `--legacy-url` → shallow `git clone --depth 1` into `legacy/` followed by deletion of `legacy/.git` (with Windows retry logic); `--legacy-path` → `copyDir(..., [".git"])`; neither → prints next-steps telling the user to populate `legacy/` manually (spec 009 US2's fail-closed warning contract; pinned wording tested in `migration/test/setup-runinstall-legacy.test.ts`).
- **`runUpdate()`** re-syncs kit files only: `.github/*`, `migration/` tools (skipping `node_modules`, `registry.db`, `-wal`, `-shm`), `harness/`, `stacks/`, `agent-shim.mjs`. Explicitly leaves `legacy/`, `modern/`, and the registry DB untouched.

### 2.3 Workspace init & config

After setup, the consumer runs `guildctl init` (cli.ts:123), which calls `scaffoldGuildConfig()` (`migration/guildctl/config.ts:scaffoldGuildConfig`): creates `.guild/config.yaml` from `DEFAULT_GUILD_CONFIG` (config.ts:46) deep-merged semantics, sets `workspace.name` and `database.path = .guild/registry.db`, creates `prompts/default`, `runs/`, `evidence/`, writes `.guild/.env.example` (key *names* only, no secrets), and calls `scaffoldWorkspaceLinks()`. Per spec 012 FR-006, the seeded default profile is generic OpenAI-compatible (`base_url https://api.openai.com/v1`, `api_key_env OPENAI_API_KEY` — config.ts:58-59, 92).

### 2.4 Modern-module bootstrap (pipeline Phase 3)

Entry points:
- `guildctl bootstrap` → `cli.ts:332` → `runBootstrap(db())`.
- `guildctl run ... bootstrap` → `cli.ts:744-746`.
- Implicitly from migration: `commands/migrate.ts:167-172` checks `needsBootstrap(db)` and auto-runs bootstrap ("↷ Target module not scaffolded") before Phase 4.

`runBootstrap()` (`bootstrap.ts:runBootstrap`):
1. Loads the active stack pack via `activePack()` → `loadActiveStack(resolveGuildConfig(...))` (`bootstrap.ts:activePack`).
2. Pulls first-class artifact signals from the registry DB: `listFirstClassArtifacts()` selects `path, module, role, framework FROM artifacts WHERE tier='first-class'`.
3. **Project type detection** — `detectBootstrapProjectType()` walks the pack manifest's `project_types` in declaration order: first pack whose `any` matcher (roles / framework substrings / path substrings) hits any artifact wins; otherwise a type whose `all_roles` covers every artifact's role; else `scaffold.default_project_type`. For `java-spring` (`package/stacks/java-spring/stack.yaml`): `web` (rest-endpoint roles etc.), `library` (all of utility/model/transformer/interface/test), fallback `service`.
4. **Base package derivation** — `deriveBootstrapBasePackage()` computes the longest common dot-prefix of all artifact `module` values (`commonPrefix()`), falls back to the first artifact's module, then to `scaffold.default_package` (`com.example.migrated`), sanitized by `sanitizePackage()` (lowercase, strip non `[a-z0-9_]` per segment).
5. **App name/class** — `deriveAppName()` takes the last package segment (kebab-cased); `className()` Pascal-cases it and appends `scaffold.app_class_marker`.
6. **Idempotence gate** — `needsBootstrap()` → `isBootstrapComplete()` checks that `modern/` already contains the build file, settings file, main+test source dirs, and (for non-library types) the resources file plus at least one source file with `scaffold.source_extension`. If complete, `runBootstrap` short-circuits with `skipped: ["modern/ (already scaffolded)"]`.
7. **Scaffolding** — `bootstrapTargetModule()` reads templates from the pack dir (`description.template`, `settings_template`, `resources_template`, `application_template` — e.g. `package/stacks/java-spring/scaffold/build.gradle.web.template`, `Application.java.template`) and renders them with simple marker replacement (`render()` replaces e.g. group/app-name/package markers). Every write goes through `maybeWriteFile()`, which **never overwrites**: existing files are recorded in `skipped`, new ones in `created`.

---

## 3. Kit contents & packaging

What ships in `migration-guild-kit.tar.gz` (per `assembleTarball()`):

| Path in kit | Origin | Purpose |
|---|---|---|
| `setup.js` | compiled `setup.ts` | the onboarding wizard |
| `README.md`, `GETTING-STARTED.md`, `AGENTS.md` | repo root | docs |
| `docs/` | repo root (optional) | extra docs |
| `package/agents/*.agent.md` | 14 agent definition files | blackboard agent roster |
| `package/skills/*` | incl. `target-module-bootstrap/SKILL.md` | agent skills |
| `package/prompts/`, `package/instructions/` | prompt/instruction markdown | agent fuel |
| `package/harness/{opencode,codex,goose}.mjs` | harness adapters | provider CLIs shims |
| `package/agent-shim.mjs` | generic adapter | default `AGENT_CMD` target |
| `package/legacy/`, `package/modern/` | empty placeholders | workspace layout |
| `package/mock/*` | mock legacy fixtures | offline test material |
| `package/stacks/{java-spring,python}` | stack packs | detection/scaffold/audit rules |
| `package/.env.example` | byte-identical to root `.env.example` | env var documentation |
| `migration/{registry,guildctl}/dist`, `migration/ui-dist` | prebuilt | runnable CLIs + UI |
| `stacks/` | root stacks copy | runtime stack packs |
| `migration/package.json` + lockfile + `registry_schema.sql` | verbatim | tarball-only `npm install` + schema |

### Mock legacy fixtures (`package/mock/`)

Documented in `package/mock/README.md`; each fixture is an intentionally dated project used to exercise the pipeline without live model calls:

- `legacy-customer-utils/` — Java 7 Maven library (commons-lang 2.x, log4j 1.x, JUnit 4); expected target plain modern Java/JUnit 5.
- `legacy-python-utils/` — tiny pytest library; Python stack-detection marker.
- `legacy-order-view/` (spec 008 US1) — Struts 1.x Action + JSP; trips `struts-action`/`jsp-view` classification signals.
- `legacy-customer-reports/` (spec 008 US2) — real Maven dependency on `legacy-customer-utils`, producing a `source_dependencies` edge that forces wave ordering (pinned by `migration/test/mock-fixture-waves.test.ts`).
- `legacy-modernization-bait/` (spec 008 US3) — dated idioms with unambiguous mappings in `package/stacks/java-spring/mappings.md`; regression bait for shallow rename-only migrations.

Because `shouldCopyPackageEntry()` only excludes top-level `legacy/`/`modern/`/`migration/` paths, everything under `package/mock/` ships verbatim in the kit.

### Stack-pack scaffold templates

`package/stacks/java-spring/scaffold/` holds `build.gradle.{web,service,library}.template`, `settings.gradle.template`, `application.yml.template`, `Application.java.template`. The `scaffold:` block of `stack.yaml` names the markers/files consumed by `bootstrapTargetModule()` (build file, settings file, source dirs, resources, extension, defaults).

---

## 4. Config & env produced

By `setup.ts` (workspace root):
- `.github/{agents,skills,prompts,instructions}/`, `.github/agent-instructions.md` (framework-substituted)
- `legacy/`, `modern/`, `migration/` (tooling), `harness/`, `stacks/`
- `.env.example` (copied only if absent — never clobbers a user's existing file), `guildctl.config.json` (legacy artifact), `agent-shim.mjs`
- `legacy/` populated via clone-or-copy when a source was given

By `guildctl init` (`config.ts:scaffoldGuildConfig`):
- `.guild/config.yaml` seeded from `DEFAULT_GUILD_CONFIG` (OpenAI-compatible default profile; `harness: opencode`)
- `.guild/registry.db` path configured; `prompts/default/`, `runs/`, `evidence/` dirs
- `.guild/.env.example` listing credential env-var *names* (`OPENROUTER_API_KEY=`, `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`) — no secret values anywhere in shipped artifacts

By `runBootstrap` (in `modern/`):
- `build.gradle` (type-specific template, group = derived base package)
- `settings.gradle` (app name marker)
- `src/main/resources/application.yml` + application class `<AppName><marker>.java` (non-library types)
- Test source dir mirroring the package path

---

## 5. Invariants & edge cases

- **Never overwrite**: both `setup.ts` (root-level `.env.example`/config/shim copies guarded by `!fs.existsSync(dest)`) and `bootstrap.ts:maybeWriteFile()` skip existing files. Re-running either is safe; results report `created` vs `skipped`.
- **Kit-source guard**: `setup.ts:main()` exits non-zero when run inside the kit tree itself (detected via `package/agent-instructions.md` under CWD).
- **No secrets in the kit**: `shouldCopyPackageEntry()` drops any `.env` file; only `.env.example` skeletons ship. Docs/specs mandate mechanism-only env documentation.
- **Tarball self-sufficiency** (spec 012 US1): `migration/package.json`, lockfile, and `registry_schema.sql` must be present; pinned by `migration/test/build-dist-packaging.test.ts` (FR-002 verbatim-copy test, FR-003 presence test, and a live SC-001 smoke test that extracts cold, npm-installs, and runs `guildctl --help` + `registry list-artifacts`).
- **Fresh-clone buildability** (spec 012 US2): `build-dist.mjs` performs nested installs itself; pinned by `migration/test/build-dist-nested-install.test.ts`; docs-skip behavior pinned by `build-dist-docs-skip.test.ts`.
- **Fail-closed legacy warning** (spec 009 US2): a run with zero legacy files must print the pinned no-legacy-source warning; pinned by `setup-runinstall-legacy.test.ts` (including the missing-directory error case).
- **Project-type detection order matters**: `detectBootstrapProjectType()` returns the *first* matching entry in manifest order; a stack pack listing `web` before `library` will classify web-bearing artifacts as web even if they also look like libraries.
- **Empty registry edge**: with zero first-class artifacts, `commonPrefix([])` returns `[]`, so base package falls back to `default_package` and detection falls through to `default_project_type` — bootstrap still works on an empty inventory.
- **Library type skips resources/app class**: `isBootstrapComplete()` and `bootstrapTargetModule()` both branch on `projectType === scaffold.library_project_type`.
- **Windows hardening**: `git clone` straight into `legacy/` (no temp-dir rename, avoiding EPERM), `.git` removal with `maxRetries`, and `resolveCommand()`/`shell:true` for npm/npx spawns in build-dist.mjs.

## 6. Gotchas

- Two different things are called "bootstrap": the pipeline phase (`guildctl run bootstrap`, modern scaffold) vs. workspace setup (`setup.js`). When reading issues/specs, check which.
- `guildctl.config.json` copied by setup is a **legacy artifact**, not live config — live config is `.guild/config.yaml` (spec 012 FR-010/FR-015; `benchmark.ts` warns about it as a legacy file).
- `--update` deliberately does *not* touch `legacy/`, `modern/`, or `registry.db`; users expecting a full re-setup must delete those or use install mode.
- The interactive wizard is effectively interactive-only: piped stdin can hit readline EOF silently (spec 012 FR-013; see `migration/test/setup-non-tty-fallback.test.ts`).
- Bootstrap derives everything from *first-class* artifacts only — if inventory hasn't classified anything yet, you get pure defaults (`com.example.migrated`, service type), which may not match your codebase. Run inventory first.
- `deriveBootstrapBasePackage` sanitizes aggressively; a reserved-word or odd-character package gets mangled (pinned by the collision/reserved-word test in `migration/test/stack-pack-engine.test.ts:260`).

## 7. Extension points

- **New stack pack**: drop a directory under `package/stacks/` (and root `stacks/`) with `stack.yaml` + `scaffold/` templates; `loadActiveStack` and `bootstrapTargetModule` consume it purely via the manifest — no code changes.
- **New project type**: add an entry to `project_types` in `stack.yaml` with `any`/`all_roles` matchers and a `scaffold/*.template`; `detectBootstrapProjectType` picks it up automatically.
- **New fixture**: follow the `package/mock/README.md` pattern (dated idioms, a legacy-side JUnit/pytest test, README tracing to a spec/US).
- **Wizard flags**: `setup.ts`'s tiny `flag()`/`hasFlag()` parser makes new non-interactive flags cheap; keep the fail-closed warning contract (spec 009 FR-006 pinned wording) intact.
- **Tarball contents**: extend the `copyJobs`/explicit copies in `assembleTarball()`; every addition should get a matching assertion in `build-dist-packaging.test.ts` per constitution principle V (prove packaging with tests, not assertions).

## Related tests

- `migration/test/build-dist-packaging.test.ts` — tarball contents, verbatim manifests, live smoke.
- `migration/test/build-dist-nested-install.test.ts`, `build-dist-docs-skip.test.ts`, `stale-dist-path-consistency.test.ts` — build script behavior.
- `migration/test/setup-runinstall-legacy.test.ts`, `setup-non-tty-fallback.test.ts` — wizard contracts.
- `migration/test/stack-pack-engine.test.ts` — `bootstrapTargetModule` rendering, package derivation, collision sanitization.
- `migration/test/cli-phase-aliases.test.ts`, `cli-run-phase-exit-code.test.ts` — `run bootstrap` wiring.
