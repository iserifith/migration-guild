# Migration Guild — Getting Started

Migrate a legacy Java codebase to Spring Boot 3 (or plain Java 17+) using AI agents.
Multiple agents run in parallel, a SQLite registry tracks every file, and your original source is never touched.

---

## What you need

- **Node.js 18+**
- One of:
  - **agent CLI** (default) — `agent` on PATH and authenticated
  - **OpenAI-compatible runtime** — API key + Azure OpenAI endpoint (see [Configure OpenAI-compatible runtime](#configure-openai-compatible-runtime) below)

---

## Setup

```bash
# 1. Extract the kit
tar -xzf __GUILDCTL_KIT_TGZ__

# 2. Create your workspace
mkdir my-migration && cd my-migration

# 3. Run the setup wizard
#    Interactive — prompts for framework and legacy repo URL
node ../__GUILDCTL_KIT_BUILD__/setup.js

#    Non-interactive alternative:
node ../__GUILDCTL_KIT_BUILD__/setup.js --framework "Spring Boot 3.x" --legacy-url https://github.com/your-org/your-repo

# 4. Install dependencies
cd migration && npm install && cd ..

# 5. Copy and fill in your .env
cp .env.example .env
#    Edit .env — set the API key env var referenced by guildctl.config.json
#    The CLI loads .env automatically — no need to source it manually
```

---

## Smoke test (verify setup before running the full pipeline)

```bash
# Should print the guildctl help text with no errors
node __MIGRATION_GUILDCTL__/dist/cli.js --help

# Should return [] (empty — nothing migrated yet)
node migration/registry/dist/cli.js list-artifacts
```

---

## Run the pipeline

```bash
# Run phase by phase (recommended for first run):
node __MIGRATION_GUILDCTL__/dist/cli.js run inventory
node __MIGRATION_GUILDCTL__/dist/cli.js run plan
node __MIGRATION_GUILDCTL__/dist/cli.js run bootstrap
node __MIGRATION_GUILDCTL__/dist/cli.js run migrate --parallel 3
node __MIGRATION_GUILDCTL__/dist/cli.js run review

# Or run all phases in one command:
node __MIGRATION_GUILDCTL__/dist/cli.js run --parallel 3
```

> **Monitor progress** — open a second terminal and run:
> ```bash
> node migration/registry/dist/cli.js serve
> # → open http://localhost:3322
> ```

---

## What the pipeline does

| Phase | What happens |
|---|---|
| Inventory | Every `.java` file in `legacy/` is registered and classified |
| Planning | Dependency graph built, files assigned to migration waves |
| Bootstrap | `modern/` scaffolded with the minimal target module structure |
| Migration | Tests written first (default/config-driven model: gpt-5.4-mini), then production code (default/config-driven model: gpt-oss-120b) |
| Review | Migrated files checked for regressions and issues |

---

## Configure OpenAI-compatible runtime

Edit `.env` and set:

```env
OPENROUTER_API_KEY=<your-key>
OPENAI_BASE_URL=https://openrouter.ai/api/v1
```

Then in `guildctl.config.json`, configure `base_url`, `model`, and `api_key_env` for an OpenAI-compatible endpoint.
For the migration pipeline, the phase keys are `analysis`, `test-writing`, and `code-writing`.

The CLI loads `.env` automatically — no `export` or `source` needed.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Agent left a file stuck | `node migration/registry/dist/cli.js release --id "<id>" --agent operator --reason "crashed"` |
| Background run failed or stalled and the next state is unclear | Run `agent --agent remediation-agent --model claude-sonnet-4.6 --yolo` |
| Nothing to claim | `node migration/registry/dist/cli.js wave-plan` |
| Files need rework | `node migration/registry/dist/cli.js list-artifacts --status needs-rework` |
| OpenAI-compatible runtime env not picked up | Ensure `.env` is in the project root (`my-migration/`), not a subdirectory |

Full CLI reference: see `README.md`.

For the internal architecture and control flow, see `__HOW_GUILDCTL_DOC__`.
