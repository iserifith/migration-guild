# Quickstart Validation — Wave 1 Workspace Source-of-Truth

End-to-end validation scenarios that prove the feature works. These are run/observe guides,
not implementation details (those live in `tasks.md` / the implement phase). Run from a clean
machine with only the distributed kit; no repo checkout required.

## Prerequisites

- Node.js 18+.
- The Migration Guild kit tarball (`migration-guild-kit.tar.gz`) produced by
  `scripts/build-dist.mjs` (which now bundles a built `migration/` runtime).
- No `guildctl.config.json` anywhere in the kit.

## Scenario A — Self-contained workspace from kit (SC-001, FR-001/FR-002)

```bash
# 1. Extract the kit
tar -xzf migration-guild-kit.tar.gz
cd migration-guild-kit-build

# 2. Create + run setup into a clean workspace
mkdir /tmp/my-migration && cd /tmp/my-migration
node /path/to/migration-guild-kit-build/setup.js --framework "Spring Boot 3.x" --yes

# 3. Smoke test — must succeed with NO surrounding checkout
node migration/dist/guildctl/cli.js --help
node migration/dist/registry/cli.js list-artifacts   # expect []

# 4. Assert: built runtime present, no orphan config
test -f migration/dist/guildctl/cli.js && echo "OK: runtime present"
test ! -e guildctl.config.json && echo "OK: no orphan guildctl.config.json"
```

Expected: both commands succeed; the orphan `guildctl.config.json` is absent.

## Scenario B — `guildctl init` with no toolkit-root (SC-003, FR-003/FR-004)

```bash
cd /tmp/my-migration
# workspace has its own migration/ package/ stacks/ — no sibling checkout
node migration/dist/guildctl/cli.js init
echo "init exit: $?"
node migration/dist/guildctl/cli.js doctor
echo "doctor exit: $?"
```

Expected: `init` exits 0, `doctor` exits 0. No "missing toolkit target" error. The
workspace's `migration/`/`package/`/`stacks/` are left intact (not re-linked).

## Scenario C — Docs-follows-config (SC-002, FR-006/FR-007)

```bash
cd /tmp/my-migration
# Edit .guild/config.yaml exactly as GETTING-STARTED now instructs:
node migration/dist/guildctl/cli.js config-set profiles.default.base_url "https://example.invalid/v1"
node migration/dist/guildctl/cli.js config-set profiles.default.api_key_env "EXAMPLE_KEY"
node migration/dist/guildctl/cli.js config-set harness "opencode"

# Confirm the edit is reflected
node migration/dist/guildctl/cli.js config | grep -E "base_url|api_key_env|harness"
```

Expected: `config` output shows the edited `base_url`, `api_key_env`, and `harness`. The
GETTING-STARTED "Configure OpenAI-compatible runtime" section must reference `.guild/config.yaml`
with these exact keys (no `guildctl.config.json` mention).

## Scenario D — Config isolation (FR-009)

```bash
mkdir -p /tmp/ws-a /tmp/ws-b
cd /tmp/ws-a && node migration/dist/guildctl/cli.js init && \
  node migration/dist/guildctl/cli.js config-set profiles.default.model "model-a"
cd /tmp/ws-b && node migration/dist/guildctl/cli.js init && \
  node migration/dist/guildctl/cli.js config-set profiles.default.model "model-b"

echo "ws-a model: $(cd /tmp/ws-a && node migration/dist/guildctl/cli.js config | grep 'model:')"
echo "ws-b model: $(cd /tmp/ws-b && node migration/dist/guildctl/cli.js config | grep 'model:')"
```

Expected: `ws-a` shows `model-a`, `ws-b` shows `model-b` — independent resolution.

## Scenario E — `--update` preserves user state (SC-006, FR-010)

```bash
cd /tmp/my-migration
# capture before-state
cp .guild/config.yaml /tmp/config.before
cp -r .guild/registry.db /tmp/registry.before 2>/dev/null || true

# run update (simulating a new kit)
node /path/to/updated-kit/setup.js --update /tmp/my-migration

# assert user state preserved
diff /tmp/config.before .guild/config.yaml && echo "OK: config preserved"
test -e .guild/registry.db && echo "OK: registry preserved"
```

Expected: `.guild/config.yaml` and `registry.db` are unchanged by `--update`; kit files refreshed.

## Regression guard (SC-005)

```bash
cd /workspace/repo        # the kit source checkout
(cd migration && npm install) && (cd migration/ui && npm install) && npm test
```

Expected: `npm test` (migration suite + Mission Control UI suite) passes. The amended
`workspace-isolation-defaults.test.ts` (no toolkit-link assertion) and any new config/doc
tests pass.
