#!/usr/bin/env bash
# update-testkit.sh — Build, sync, and update a guildctl test workspace.
#
# Usage:
#   scripts/update-testkit.sh <workspace-path> [revert-state]
#
# Arguments:
#   workspace-path   Absolute or relative path to the test workspace root.
#   revert-state     Optional. Reset the workspace to just before this pipeline
#                    phase. Supported values:
#                      clean        Full reset — delete DB, logs, artifacts.
#                                   Workspace is ready to run from scratch.
#                      pre-plan     Keep inventory (artifacts stay pending).
#                                   Clears wave assignments, runs, claims, events.
#                      pre-migrate  Keep inventory + plan (waves intact).
#                                   Resets statuses back to planned, clears
#                                   migrate/review runs, claims, events.
#                      pre-review   Keep inventory + plan + migration output.
#                                   Resets statuses back to migrated, clears
#                                   review runs, claims, events.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${1:-}"
REVERT_STATE="${2:-}"

# ── Validate args ─────────────────────────────────────────────────────────────

if [[ -z "$WORKSPACE" ]]; then
  echo "Usage: $(basename "$0") <workspace-path> [revert-state]" >&2
  exit 1
fi

WORKSPACE="$(cd "$WORKSPACE" && pwd)"

if [[ ! -d "$WORKSPACE" ]]; then
  echo "Error: workspace not found: $WORKSPACE" >&2
  exit 1
fi

VALID_STATES=("clean" "pre-plan" "pre-migrate" "pre-review")
if [[ -n "$REVERT_STATE" ]]; then
  VALID=false
  for s in "${VALID_STATES[@]}"; do
    [[ "$REVERT_STATE" == "$s" ]] && VALID=true && break
  done
  if [[ "$VALID" == false ]]; then
    echo "Error: unknown revert state '$REVERT_STATE'." >&2
    echo "       Valid states: ${VALID_STATES[*]}" >&2
    exit 1
  fi
fi

# ── Step 1: Rebuild migration CLI ─────────────────────────────────────────────

echo ""
echo "━━━ 1/4  Rebuilding migration CLI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cd "$REPO_ROOT/migration"
npx tsup 2>&1 | grep -E "Build success|Build start|error|Error" || true
echo "  ✓ migration CLI rebuilt"

# ── Step 2: Sync migration/ → package/tools/ ─────────────────────────────────

echo ""
echo "━━━ 2/4  Syncing package/tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
rsync -rc \
  --exclude 'node_modules/' \
  --exclude 'artifacts/' \
  --exclude 'logs/' \
  --exclude 'registry.db*' \
  --exclude '.env' \
  --exclude '.env.example' \
  "$REPO_ROOT/migration/" "$REPO_ROOT/package/tools/"
echo "  ✓ package/tools synced"

# ── Step 3: Build setup.js + update workspace ────────────────────────────────

echo ""
echo "━━━ 3/4  Building setup.js and updating workspace ━━━━━━━━━━━━━━━━━━━"
cd "$REPO_ROOT"
npm run build 2>&1 | grep -E "success|error|Error" || true

cd "$WORKSPACE"
node "$REPO_ROOT/dist/setup.js" --update 2>&1 | grep -E "Done\.|↺|error|Error" | tail -20

echo ""
echo "━━━ 4/4  Installing workspace dependencies ━━━━━━━━━━━━━━━━━━━━━━━━━━"
cd "$WORKSPACE/migration"
npm install --silent
echo "  ✓ npm install done"

# ── Step 4 (optional): Revert state ──────────────────────────────────────────

if [[ -z "$REVERT_STATE" ]]; then
  echo ""
  echo "✓ Done. No revert requested — workspace is at its current state."
  echo "  Workspace: $WORKSPACE"
  exit 0
fi

DB="$WORKSPACE/migration/registry.db"
LOGS="$WORKSPACE/migration/logs"
ARTIFACTS="$WORKSPACE/migration/artifacts"

echo ""
echo "━━━ Reverting to: $REVERT_STATE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

case "$REVERT_STATE" in

  clean)
    rm -f "$DB" "$DB-shm" "$DB-wal"
    rm -rf "$LOGS"
    rm -rf "$ARTIFACTS"
    echo "  ✓ Registry DB, logs, and artifacts deleted — ready for fresh inventory"
    ;;

  pre-plan)
    if [[ ! -f "$DB" ]]; then
      echo "  ✓ No DB found — already in clean state (pre-inventory)"
    else
      node - "$DB" <<'EOF'
const DB = require("better-sqlite3");
const db = new DB(process.argv[2]);
db.exec(`
  UPDATE artifacts SET status = 'pending', wave = NULL;
  DELETE FROM artifact_claims;
  DELETE FROM runs;
  DELETE FROM events;
`);
db.close();
EOF
      echo "  ✓ All artifacts reset to pending, waves cleared, runs/claims/events deleted"
    fi
    rm -rf "$LOGS"
    ;;

  pre-migrate)
    if [[ ! -f "$DB" ]]; then
      echo "  ✗ No DB found. Cannot revert to pre-migrate without inventory data." >&2
      exit 1
    fi
    node - "$DB" <<'EOF'
const DB = require("better-sqlite3");
const db = new DB(process.argv[2]);
db.exec(`
  UPDATE artifacts
    SET status = 'planned'
    WHERE status IN ('analyzed','in-progress','tests-written','migrated','reviewed','needs-rework','completed');
  DELETE FROM artifact_claims
    WHERE run_id IN (SELECT run_id FROM runs WHERE phase IN ('migrate','bootstrap','review'));
  DELETE FROM runs WHERE phase IN ('migrate','bootstrap','review');
  DELETE FROM events WHERE type NOT IN ('status_changed','registered','planned');
`);
db.close();
EOF
    echo "  ✓ Artifacts with post-plan statuses reset to planned; migrate/review runs cleared"
    rm -rf "$LOGS"
    ;;

  pre-review)
    if [[ ! -f "$DB" ]]; then
      echo "  ✗ No DB found. Cannot revert to pre-review without migration data." >&2
      exit 1
    fi
    node - "$DB" <<'EOF'
const DB = require("better-sqlite3");
const db = new DB(process.argv[2]);
db.exec(`
  UPDATE artifacts
    SET status = 'migrated'
    WHERE status IN ('reviewed','needs-rework','completed');
  DELETE FROM artifact_claims
    WHERE run_id IN (SELECT run_id FROM runs WHERE phase = 'review');
  DELETE FROM runs WHERE phase = 'review';
  DELETE FROM events WHERE type = 'reviewed';
`);
db.close();
EOF
    echo "  ✓ Reviewed/completed artifacts reset to migrated; review runs cleared"
    rm -rf "$LOGS"
    ;;

esac

echo ""
echo "✓ Done."
echo "  Workspace : $WORKSPACE"
echo "  State     : $REVERT_STATE"
echo ""
