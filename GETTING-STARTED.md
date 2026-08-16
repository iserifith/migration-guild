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

### Repository test setup

From the Migration Guild repository root, install both test suites and run them with one command:

```bash
(cd migration && npm install) && (cd migration/ui && npm install) && npm test
```

---

## Smoke test (verify setup before running the full pipeline)

```bash
# Should print the guildctl help text with no errors
node migration/dist/guildctl/cli.js --help

# Should return [] (empty — nothing migrated yet)
node migration/dist/registry/cli.js list-artifacts
```

---

### Environment precedence (behaviour change)

The workspace `.env` is loaded automatically and wins over inherited environment values by default.
Use `guildctl --ambient-env <command>` or `GUILD_ENV_PRECEDENCE=ambient guildctl <command>` only
when ambient precedence is intentional. Divergences are reported at run start and credential values
are redacted. In particular, a workspace `.env` value for `AGENT_CMD` now wins over an exported
ambient `AGENT_CMD`; this can change which harness is launched.

---

### Effective time limits

Each phase's wall-clock ceiling and inactivity timeout resolve through one precedence order,
first match wins: **per-phase setting → environment override → project configuration → built-in
default**. Run `node migration/dist/guildctl/cli.js limits` to see, per phase, which knob
governs, the effective value, and whether a floor was applied (5 minutes for analyze/test/
code-writing/remediation, 1 minute for review/inventory). A kill message always names the knob
that actually fired, so raising the wrong setting never silently does nothing. This is unrelated
to `auto-run --limit <n>`, which bounds the number of artifacts processed, not time.

---

## Run the pipeline

```bash
# Run phase by phase (recommended for first run):
node migration/dist/guildctl/cli.js run inventory
node migration/dist/guildctl/cli.js run plan
node migration/dist/guildctl/cli.js run bootstrap
node migration/dist/guildctl/cli.js run migrate --parallel 3
node migration/dist/guildctl/cli.js run review

# Or run all phases in one command:
node migration/dist/guildctl/cli.js run --parallel 3
```

> **Monitor progress** — open a second terminal and run:
> ```bash
> node migration/dist/registry/cli.js serve
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
| Agent left a file stuck | `node migration/dist/registry/cli.js release --id "<id>" --agent operator --reason "crashed"` |
| Background run failed or stalled and the next state is unclear | Run `agent --agent remediation-agent --model claude-sonnet-4.6 --yolo` |
| Nothing to claim | `node migration/dist/registry/cli.js wave-plan` |
| Files need rework | `node migration/dist/registry/cli.js list-artifacts --status needs-rework` |
| OpenAI-compatible runtime env not picked up | Ensure `.env` is in the project root (`my-migration/`), not a subdirectory |

Full CLI reference: see `README.md`.

For the internal architecture and control flow, see `__HOW_GUILDCTL_DOC__`.
