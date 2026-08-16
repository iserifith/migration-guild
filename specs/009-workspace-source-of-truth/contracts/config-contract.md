# Contract: Workspace Config & Onboarding CLI (Wave 1)

Project type: CLI tooling / onboarding. The externally visible contracts are (1) the
**workspace configuration file** the runtime actually loads, (2) the **`guildctl init`**
command contract, and (3) the **`setup.ts`** setup contract. These are the surfaces a kit
user touches; they must agree on one source of truth.

## Contract 1 — Configuration file (source of truth)

- **Single file:** `.guild/config.yaml` at the workspace root is the ONLY configuration
  file the runtime reads. There is no second, competing config file.
- **Removed file:** `guildctl.config.json` at the workspace root is NOT produced by
  `setup.ts`, NOT bundled in the kit, NOT copied by `benchmark.ts`, and NOT referenced by
  any doc. If a stale one exists from an older setup, it is ignored by the runtime and
  SHOULD be removed during `--update` (or at minimum documented as dead).
- **Schema the user edits** (OpenAI-compatible runtime):
  - `profiles.default.base_url` — OpenAI-compatible endpoint URL.
  - `profiles.default.api_key_env` — name of the env var holding the key (e.g. `ROOTSYS_API_KEY`).
  - `profiles.default.model` — model id.
  - top-level `harness:` — harness selector (e.g. `opencode`).
- **Resolution:** `guildctl config` reads `.guild/config.yaml`; `guildctl config-set <key> <value>`
  writes to it. Edits are reflected on next `guildctl config` (already true in code; the
  contract change is *documentation + orphan removal*).
- **Isolation:** config resolves from the invoking workspace's own `.guild/`. Two workspaces
  on one machine do not cross-contaminate.

### Acceptance (testable)
- Given GETTING-STARTED's configure section followed verbatim, `guildctl config` shows the
  edited `profiles.default.base_url` / `api_key_env` / `model` / `harness`.
- Given a workspace after setup, `guildctl.config.json` does not exist at the root.

## Contract 2 — `guildctl init`

- **Precondition:** runs in a workspace directory (cwd, or `--workspace <dir>`).
- **Postcondition on success (exit 0):**
  - `.guild/config.yaml` exists (created from `DEFAULT_GUILD_CONFIG`, with `workspace.name`
    set to the directory basename, `database.path` = `.guild/registry.db`).
  - `.guild/prompts/default/`, `.guild/runs/`, `.guild/evidence/` exist.
  - `.guild/.env.example` exists (if not already present).
  - The workspace's own `migration/`, `package/`, `stacks/` directories are **left intact**
    (NOT re-linked to a sibling toolkit root).
- **No toolkit-root requirement:** `init` MUST succeed when the workspace has NO sibling
  `package/`/`stacks/`/`migration/` checkout. It uses the workspace-local copies.
- **Failure mode:** if a genuinely required input is absent (e.g. no `migration/` and no
  toolkit root to fall back to), `init` emits an actionable, human-readable message naming
  exactly what to run or provide. It MUST NOT throw a cryptic "missing toolkit target" error.
- **Idempotency:** `init` without `--force` preserves an existing `.guild/config.yaml`.

### Acceptance (testable)
- `guildctl init` exits 0 in a tarball-extracted/copied workspace with no sibling toolkit-root.
- `guildctl doctor` passes afterwards.
- Re-running `init` does not clobber an edited `.guild/config.yaml`.

## Contract 3 — `setup.ts` (install & `--update`)

- **Install:** produces a self-contained workspace containing `migration/` (built runtime,
  `migration/dist/guildctl/cli.js` present), `package/`, `stacks/`, `harness/`, `.github/*`,
  `.env.example`, and the kit docs. It does NOT copy `guildctl.config.json`.
- **Smoke test enabled:** after install, `node migration/dist/guildctl/cli.js --help`
  succeeds with no surrounding checkout.
- **`--update`:** refreshes kit files (agents, skills, prompts, instructions, `migration/`,
  `harness/`, `stacks/`, config templates) while preserving `registry.db`, `legacy/`,
  `modern/`, and existing `.guild/config.yaml`.
- **Kit assembly (`scripts/build-dist.mjs`):** the produced tarball includes a pre-built
  `migration/` runtime so the extract-and-run path needs no separate build step.

### Acceptance (testable)
- From only the distributed kit (tarball), extract → `node setup.js` → smoke test passes.
- `--update` preserves user-owned state (before/after comparison in upgrade test, SC-006).

## Non-contracts / out of scope

- Runtime behavior of phases (inventory/migrate/etc.) is unchanged.
- `legacy/`/`modern/` contents are user data, not part of this contract beyond preservation.
- Provider/harness *resolution* logic (Wave 3) is untouched here; this phase only guarantees
  the workspace + config that Wave 3 will operate on actually exist and agree.
