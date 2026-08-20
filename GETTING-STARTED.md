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
#    Local-directory alternative (no git clone):
node ../__GUILDCTL_KIT_BUILD__/setup.js --legacy-path /path/to/your/legacy/code

> **Interactive prompts require a TTY.** With no `--framework`/`--legacy-url`/`--legacy-path`
> flags, the wizard prompts interactively — but only when stdin is a TTY. When stdin is **not**
> interactive (`setup.js < /dev/null`, from CI, or with stdin detached), the wizard detects this
> up front and short-circuits straight to the documented defaults (framework = `Spring Boot 3.x`,
> no legacy source), printing a stderr note, and still scaffolds the workspace (`.github/`,
> `migration/`, `package/`, `stacks/`, …) instead of hanging or silently exiting with nothing.
> Piped input that runs out mid-wizard resolves any remaining prompt to its default with a stderr
> note. Either way a workspace is always produced; pass the flags for scripted installs. The
> `.guild/` config is created separately by `init` (step 5 below), not by the wizard itself.

# 4. Install runtime dependencies
#    migration/ ships with the kit; this only installs its node_modules.
cd migration && npm install && cd ..

# 5. Scaffold the workspace config (.guild/config.yaml + prompt pack)
#    REQUIRED — the CLI reads .guild/config.yaml, not any other file.
node migration/guildctl/dist/cli.js init

# 6. Copy and fill in your .env
cp .env.example .env
#    Edit .env — set the API key env var referenced by .guild/config.yaml
#    (see "Configure OpenAI-compatible runtime" below)
#    The CLI loads .env automatically — no need to source it manually
```

## Smoke test (verify setup before running the full pipeline)

```bash
# Should print the guildctl help text with no errors
node migration/guildctl/dist/cli.js --help

# Should return [] (empty — nothing migrated yet)
node migration/registry/dist/cli.js list-artifacts
```

---

### Environment precedence (behaviour change)

The workspace `.env` is loaded automatically and wins over inherited environment values by default.
Use `guildctl --ambient-env <command>` or `GUILD_ENV_PRECEDENCE=ambient guildctl <command>` only
when ambient precedence is intentional. Divergences are reported at run start and credential values
are redacted. In particular, a workspace `.env` value for `AGENT_CMD` now wins over an exported
ambient `AGENT_CMD`; this can change which harness is launched.

> **Empty vs unset `.env` credentials (#119).** A blank value in `.env` (e.g. `OPENROUTER_API_KEY=`)
> is treated as *defined-but-empty*, **not** as a directive to wipe a working ambient credential. The
> runner keeps the ambient value and reports the divergence — so an empty `.env` line never silently
> discards a credential your shell already provided. Set the value for real, or delete the line
> entirely, to let the ambient value through unremarked.

---

### Harness selection precedence

The active harness resolves in this order (first match wins):

1. `GUILDCTL_HARNESS` environment variable (highest priority).
2. `harness:` in `.guild/config.yaml` (project config).
3. `opencode` (built-in default).

`AGENT_CMD` is independent of the above and, when set, is always selected as a `custom` harness.
An empty/whitespace `GUILDCTL_HARNESS` falls through to config, then the opencode default.

> **The selected harness CLI must be installed.** `guildctl doctor` probes the resolved harness
> program and **fails closed** if it is missing or unreachable — run `guildctl doctor` after setup
> to confirm your harness is healthy before starting the pipeline.

---

### Effective time limits

Each phase's wall-clock ceiling and inactivity timeout resolve through one precedence order,
first match wins: **per-phase setting → environment override → project configuration → built-in
default**. Run `node migration/guildctl/dist/cli.js limits` to see, per phase, which knob
governs, the effective value, and whether a floor was applied (5 minutes for analyze/test/
code-writing/remediation, 1 minute for review/inventory). A kill message always names the knob
that actually fired, so raising the wrong setting never silently does nothing. This is unrelated
to `auto-run --limit <n>`, which bounds the number of artifacts processed, not time.

---

## Run the pipeline

```bash
# Run phase by phase (recommended for first run):
node migration/guildctl/dist/cli.js run inventory
node migration/guildctl/dist/cli.js run plan
node migration/guildctl/dist/cli.js run bootstrap
node migration/guildctl/dist/cli.js run migrate --parallel 3
node migration/guildctl/dist/cli.js run review

# Or run all phases in one command:
node migration/guildctl/dist/cli.js run --parallel 3
```

> **Autonomous runs (`auto` / `auto-run`) need the registry DB outside the workspace.**
> `guildctl init` scaffolds `database.path` inside the workspace, which is fine for the
> phase-by-phase commands above — but the autonomous queue fail-closes with
> `Autonomous runs require REGISTRY_DB outside the target workspace`. This is a deliberate
> safety guard (it keeps the state DB out of the tree the migrate/warden steps mutate), not a
> bug. Before running `node migration/guildctl/dist/cli.js auto …` or `auto-run`, point the
> registry at a path outside the workspace — either:
> ```bash
> # one-shot override on the command:
> node migration/guildctl/dist/cli.js auto-run --db ../migration-registry.db
> # …or export it for the shell session:
> export REGISTRY_DB="$(pwd)/../migration-registry.db"
> ```
> Phase-by-phase `run <phase>` commands do not need this override.

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

The CLI reads its runtime config **not** from `guildctl.config.json` (deleted; nothing reads it) but from
`.guild/config.yaml` (created by `guildctl init`). Edit `.guild/config.yaml` and set the default profile plus the harness:

```yaml
# .guild/config.yaml (created by `node migration/guildctl/dist/cli.js init`)
harness:
  type: openai-compatible        # how phases invoke the model runtime
profiles:
  default:
    base_url: https://openrouter.ai/api/v1
    model: openai/gpt-oss-120b
    api_key_env: OPENROUTER_API_KEY
```

`api_key_env` names the variable `guildctl init` writes into your `.env` (default `OPENAI_API_KEY`).
Set that variable's value in `.env`:

```env
OPENROUTER_API_KEY=<your-key>
```

For the migration pipeline, the phase keys are `analysis`, `test-writing`, and `code-writing`.
You can set a per-phase model under `profiles.default` (e.g. `profiles.default.analysis.model`).
The CLI loads `.env` automatically — no `export` or `source` needed.

Run `node migration/guildctl/dist/cli.js config` to print the resolved config and confirm your
edits took effect. If `config` still shows stale defaults, you edited the wrong file — only
`.guild/config.yaml` is read.

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
