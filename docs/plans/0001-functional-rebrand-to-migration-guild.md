# Functional Rebrand to Migration Guild Implementation Plan

> **For Hermes:** Use `subagent-driven-development` or a focused coding agent to implement this plan task-by-task. Do not blind global-replace `legmod`.

**Goal:** Functionally rebrand the project into **Migration Guild** with public CLI command **`guildctl`**, while preserving internal contracts needed for demo stability.

**Product principle:** **Evidence-first modernization.** Migration Guild accepts modernization through executable proof, not model confidence, vibes, or writer self-approval. This rebrand should surface that language where product positioning appears; full evidence-gate implementation remains a later product-foundation task unless explicitly pulled into scope.

**Architecture:** This is a public/product surface rebrand. The internal runner/agent/build nervous system remains mostly intact: `LEGMOD_*`, `legmod/` path segments, `LegmodConfig`, and `registry` stay for now.

**Tech Stack:** TypeScript/Node CLI, SQLite registry, React UI, npm package/bin metadata, generated `dist`/`ui-dist` artifacts.

---

## Identity map

### Public/user-facing references to change

- Product/display name: `legmod` / `Happy Little Bots` → **Migration Guild**
- Public command: `legmod` → **`guildctl`**
- Setup command: `legmod-setup` → **`guildctl-setup`**
- Package scope/name: `@happylittlebot/*` → **`@migration-guild/*`**
- Config filename: `legmod.config.json` → **`guildctl.config.json`**
- Log prefix: `[legmod]` → **`[guildctl]`**
- UI title/header: `legmod registry` / `Happy Little Bots` → **Migration Guild Registry** / **Migration Guild**
- Tarball/build artifact names: `happylittlebot-kit*` / `legmod-kit*` → **`migration-guild-kit*`**

### Internal references to keep

Keep these exact strings unless a later explicit decision changes them:

- `LEGMOD_*` env vars
- `legmod/` folder
- `legmod/dist/cli.js`
- `legmod/cli.ts`
- `LegmodConfig`
- `registry` CLI identity
- tsup/build entries pointing at internal `legmod` paths

### High-risk files/groups

- `**/dist/**` — generated; regenerate only
- `**/ui-dist/**` — generated; regenerate only
- `package/setup.js` — generated from `setup.ts`; regenerate only
- `package-lock.json` files — regenerate through npm, do not hand-edit dependency graph
- `package/agents/*.agent.md` — contain `LEGMOD_*` and command snippets; audit carefully
- `test/cli-phase-aliases.test.ts` — pre-existing hardcoded path issue; do not fix as part of rebrand

---

## Ordered phases

### Phase 0 — Baseline and source-of-truth docs

**Objective:** Record current state and guardrails before editing.

**Files:**
- Created: `docs/decisions/0001-rebrand-to-migration-guild.md`
- Created: `docs/plans/0001-functional-rebrand-to-migration-guild.md`

**Steps:**

```bash
git status --short
git grep -c legmod | awk -F: '{s+=$2} END{print s}'
diff -rq migration package/tools | grep -v node_modules || true
cd migration && npm test
```

Expected: tests may include pre-existing failures in `test/cli-phase-aliases.test.ts` due to hardcoded `/Users/seri/Workspace/legmod/migration` path. Record failures; do not fix here.

---

### Phase 1 — Package and CLI identity

**Objective:** Make the public command `guildctl` with no `legmod` alias.

**Files:**
- Modify: `package/tools/package.json`
- Modify: `migration/package.json`
- Modify: `package.json`
- Modify: `package/tools/legmod/cli.ts`
- Modify: `migration/legmod/cli.ts`

**Changes:**

1. In `package/tools/package.json` and `migration/package.json`:
   - package name/scope: `@happylittlebot/registry` or prior public package name → `@migration-guild/registry`
   - bin key: `legmod` → `guildctl`
   - bin target remains: `legmod/dist/cli.js`
   - keep `registry` bin unchanged

   Target pattern:
   ```json
   "bin": {
     "registry": "registry/dist/cli.js",
     "guildctl": "legmod/dist/cli.js"
   }
   ```

2. In root `package.json`:
   - package name: previous kit package → `@migration-guild/kit`
   - bin key: `legmod-setup` or old setup command → `guildctl-setup`
   - setup target remains the compiled setup path

3. In both `legmod/cli.ts` files:
   - `.name("legmod")` → `.name("guildctl")`
   - CLI description should say: `guildctl — Migration Guild orchestrator`

**Verification:**

```bash
npm pkg get bin
cd migration && npm pkg get bin
```

Expected:
- no public `legmod` bin
- `guildctl` exists
- `registry` still exists

---

### Phase 2 — Config filename and public prefixes

**Objective:** Rename public config identity while keeping internal type names stable.

**Files:**
- Rename: `legmod.config.json` → `guildctl.config.json` where present
- Rename: `package/legmod.config.json` → `package/guildctl.config.json` if present
- Modify: `package/tools/foundry/config.ts`
- Modify: `migration/foundry/config.ts`
- Modify: `.env.example` files if they reference config names

**Changes:**

1. Replace public config filename references:
   - `legmod.config.json` → `guildctl.config.json`

2. Replace log prefixes:
   - `[legmod]` → `[guildctl]`

3. Keep internal type/interface names:
   - `LegmodConfig` stays unchanged

**Verification:**

```bash
git grep -n 'legmod.config.json' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
git grep -n '\[legmod\]' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
```

Expected: no public results outside decision/history docs.

---

### Phase 3 — UI identity

**Objective:** Rebrand dashboard and visible UI.

**Files:**
- Modify: `package/tools/ui/index.html`
- Modify: `migration/ui/index.html`
- Modify: `package/tools/ui/src/App.tsx`
- Modify: `migration/ui/src/App.tsx`
- Modify: `package/tools/ui/src/constants.ts` if it contains visible `legmod`
- Modify: `migration/ui/src/constants.ts` if it contains visible `legmod`

**Changes:**

- `<title>legmod registry</title>` → `Migration Guild Registry`
- Visible header/prose: `legmod` / old product name → `Migration Guild`

**Verification:**

```bash
git grep -nE '\blegmod\b|Happy Little Bots' -- package/tools/ui migration/ui ':!*/ui-dist/*'
```

Expected: no public UI/display references to old names. Internal allowed hits only if justified.

---

### Phase 4 — Setup, build artifact names, and docs command surface

**Objective:** Update installer/setup text, build artifact names, and docs commands.

**Files:**
- Modify: `setup.ts`
- Regenerate: `package/setup.js`
- Modify: `scripts/build-dist.mjs`
- Modify: `README.md`
- Modify: `GETTING-STARTED.md`
- Modify: `DEVELOPMENT.md`
- Modify: `AGENTS.md`
- Modify: `package/AGENTS.md`
- Modify: `package/copilot-instructions.md`
- Modify: `.github/**` if public-facing references exist
- Modify: `CHANGELOGS.MD`
- Modify: `docs/**/*.md`

**Changes:**

- Banners/product prose: `legmod` / `Happy Little Bots` → `Migration Guild`
- Setup command: old setup command → `npx guildctl-setup`
- Public typed command examples: `legmod ...` → `guildctl ...`
- Tagline: `Migration Guild — a blackboard society for legacy software modernization`
- Artifact names: old kit tarball/build-dir names → `migration-guild-kit.tar.gz` and `migration-guild-kit-build`

**Important:** keep internal path examples if they are explicitly node-by-path invocations, e.g. `node migration/legmod/dist/cli.js`, unless a safer generated wrapper exists.

**Verification:**

```bash
git grep -nE 'legmod-setup|npx legmod\b|happylittlebot-kit|legmod-kit|Happy Little Bots' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
```

Expected: no public old-name results outside decision/history docs.

---

### Phase 5 — Agent prompts and internal docs audit

**Objective:** Remove public product references without breaking agent/runner contracts.

**Files:**
- Audit: `package/agents/*.agent.md`
- Audit: `migration/agents/*.agent.md`
- Audit: `package/prompts/**`
- Audit: `migration/prompts/**`
- Audit: `package/skills/**`
- Audit: `migration/skills/**`

**Change only:**

- prose like `legmod kit` → `Migration Guild`
- public command examples `legmod` → `guildctl`

**Do not change:**

- `${LEGMOD_*}`
- `LEGMOD_*`
- `node migration/registry/dist/cli.js`
- internal `legmod/` path snippets

**Verification:**

```bash
git grep -nE '\bLEGMOD_[A-Z_]+' -- package migration
```

Expected: env vars still exist and are unchanged.

---

### Phase 6 — Mirror, regenerate, verify

**Objective:** Ensure generated artifacts and mirrored trees are consistent.

**Steps:**

1. Ensure `package/tools/` and `migration/` stay synchronized.

2. Regenerate generated artifacts:
   ```bash
   npm run build
   npm run build:dist
   ```

3. Refresh lockfiles through package manager if package names or bin metadata changed:
   ```bash
   npm install
   (cd migration && npm install)
   (cd package/tools && npm install)
   ```

4. Verify mirrored trees:
   ```bash
   diff -rq migration package/tools | grep -v node_modules || true
   ```

5. Run command checks:
   ```bash
   node migration/legmod/dist/cli.js --help
   node migration/legmod/dist/cli.js --version
   node migration/registry/dist/cli.js --help
   ```

Expected:
- orchestrator help says `guildctl`
- version still works
- registry help still says `registry`

---

## Final acceptance criteria

### Search gates

Allowed remaining `legmod` hits are only internal allow-list items.

Run:

```bash
git grep -nE '\blegmod\b' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
```

Allowed:

- `LEGMOD_*`
- `legmod/` path segments
- `legmod/cli.ts` / `legmod/dist/cli.js`
- `LegmodConfig`
- tsup/build entries that point at internal paths
- historical decision/planning references that explicitly document the old name
- test fixture temp paths containing `legmod-*`
- internal agent IDs / DB claim owner values that must remain stable for now

Old-name gates that should have no public leaks:

```bash
git grep -n '@happylittlebot/' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
git grep -n 'legmod.config.json' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
git grep -n 'legmod-setup' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
git grep -nE 'npx legmod\b|\blegmod run\b' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
git grep -n '\[legmod\]' -- ':!*/dist/*' ':!*/ui-dist/*' ':!*.map'
```

Expected: empty or decision/history docs only.

New-name gates that should exist:

```bash
git grep -n '@migration-guild/' package.json migration/package.json package/tools/package.json package-lock.json migration/package-lock.json package/tools/package-lock.json
git grep -n 'guildctl.config.json'
git grep -n 'guildctl-setup' package.json README.md GETTING-STARTED.md DEVELOPMENT.md
git grep -nE '\bguildctl\b' migration/legmod/cli.ts package/tools/legmod/cli.ts setup.ts README.md
```

### Build/test gates

```bash
npm run build
npm run build:dist
cd migration && npm test
```

Expected:
- build passes
- dist build produces Migration Guild artifact names
- no new test failures versus Phase 0 baseline

### CLI gates

```bash
node migration/legmod/dist/cli.js --help
node migration/legmod/dist/cli.js --version
node migration/registry/dist/cli.js --help
```

Expected:
- public command identity is `guildctl`
- no public `legmod` alias
- `registry` unchanged

---

## Coding agent task packet

### Mission

Implement the functional rebrand to **Migration Guild** / **`guildctl`** without breaking internal runner/agent contracts.

### Constraints

1. Do not blind global-replace `legmod`.
2. Do not rename `LEGMOD_*` env vars.
3. Do not rename the `legmod/` folder.
4. Do not rename `LegmodConfig`.
5. Do not rename `registry` CLI.
6. Do not create a `legmod` public command alias.
7. Do not hand-edit generated files; regenerate them.
8. Keep `package/tools/` and `migration/` synchronized.
9. Do not fix unrelated pre-existing test path failures.

### Inspect first

Read these before editing:

- `docs/decisions/0001-rebrand-to-migration-guild.md`
- `package/tools/package.json`
- `migration/package.json`
- `package.json`
- `package/tools/legmod/cli.ts`
- `migration/legmod/cli.ts`
- `package/tools/foundry/config.ts`
- `migration/foundry/config.ts`
- `setup.ts`
- `scripts/build-dist.mjs`
- `package/tools/ui/src/App.tsx`
- `migration/ui/src/App.tsx`
- `package/agents/*.agent.md`
- `migration/agents/*.agent.md`

### Stop conditions

Stop and report if:

- a needed change requires renaming `LEGMOD_*`
- a needed change requires renaming `legmod/` folder
- `diff -rq migration package/tools` shows unexplained drift
- a test that passed in baseline starts failing
- grep gates show non-allowlisted `legmod` hits but fixing them would touch internal contracts

### Commit suggestion

After passing verification:

```bash
git add docs package migration scripts README.md GETTING-STARTED.md DEVELOPMENT.md AGENTS.md CHANGELOGS.MD package.json package-lock.json guildctl.config.json
git commit -m "rebrand: migrate public surface to Migration Guild"
```

Adjust staged files to actual changed paths.
