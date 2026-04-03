#!/usr/bin/env bash
# build-dist.sh — Build and package legmod-kit for distribution.
#
# Output: dist/legmod-kit.tar.gz
# Usage:  ./scripts/build-dist.sh [--version 1.2.3]
#
# The tarball extracts to legmod-kit-build/ and contains everything a
# consumer needs to run: setup.js, docs, package/ (agents, skills, prompts,
# instructions, tools with pre-built dist/).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist"
BUILD_DIR="${DIST_DIR}/legmod-kit-build"
TARBALL="${DIST_DIR}/legmod-kit.tar.gz"

# ── Version bump (optional) ──────────────────────────────────────────────────
VERSION=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [[ -n "$VERSION" ]]; then
  echo "  Bumping version to ${VERSION}"
  node -e "
    const fs = require('fs');
    const p = '${REPO_ROOT}/package.json';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '${VERSION}';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  "
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       legmod-kit dist builder        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Step 1: Build tools (registry + legmod CLI + foundry) ───────────────────
echo "▶ Step 1/3 — Build package/tools (tsup)"
cd "${REPO_ROOT}/package/tools"
npx tsup 2>&1 | tail -5
echo "  ✓ tools built"

# ── Step 2: Build setup.ts → dist/setup.js ──────────────────────────────────
echo "▶ Step 2/3 — Build setup.ts (tsup)"
cd "${REPO_ROOT}"
npm run build 2>&1 | tail -5
echo "  ✓ setup.js built"

# ── Step 3: Assemble tarball ─────────────────────────────────────────────────
echo "▶ Step 3/3 — Assemble dist/legmod-kit.tar.gz"

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# Top-level files
cp "${REPO_ROOT}/dist/setup.js"        "${BUILD_DIR}/setup.js"
cp "${REPO_ROOT}/README.md"            "${BUILD_DIR}/README.md"
cp "${REPO_ROOT}/GETTING-STARTED.md"  "${BUILD_DIR}/GETTING-STARTED.md"
cp "${REPO_ROOT}/AGENTS.md"           "${BUILD_DIR}/AGENTS.md"

# docs/
cp -r "${REPO_ROOT}/docs"             "${BUILD_DIR}/docs"

# package/ — copy selectively, exclude source node_modules and raw .ts files
# that aren't needed at runtime
mkdir -p "${BUILD_DIR}/package"

rsync -a \
  --exclude="node_modules" \
  --exclude="*.ts" \
  --include="*.ts.map" \
  --exclude=".env" \
  --exclude="legacy/*" \
  --exclude="modern/*" \
  --exclude="migration/" \
  "${REPO_ROOT}/package/" \
  "${BUILD_DIR}/package/"

# Keep .env.example but not .env
if [[ -f "${REPO_ROOT}/package/.env.example" ]]; then
  cp "${REPO_ROOT}/package/.env.example" "${BUILD_DIR}/package/.env.example"
fi

# Restore empty placeholder dirs that rsync may skip
mkdir -p "${BUILD_DIR}/package/legacy"
mkdir -p "${BUILD_DIR}/package/modern"
touch    "${BUILD_DIR}/package/modern/.gitkeep"

# Pack
cd "${DIST_DIR}"
rm -f "${TARBALL}"
tar -czf "${TARBALL}" legmod-kit-build/
rm -rf "${BUILD_DIR}"

BYTES=$(wc -c < "${TARBALL}" | tr -d ' ')
echo "  ✓ ${TARBALL} ($(( BYTES / 1024 )) KB)"

echo ""
echo "  Done! Distribute with:"
echo "    curl -fsSL <url>/legmod-kit.tar.gz | tar -xz && node legmod-kit-build/setup.js"
echo ""
