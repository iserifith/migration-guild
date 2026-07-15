# Autonomous Canary Evidence

Date: 2026-07-15

## Commands Run

- `node --import tsx --test test/warden.test.ts test/auto-canary.test.ts`
  - Result: PASS, 15/15 tests.
  - Covered exact SQLite registry DB sidecar exclusions and autonomous canary behavior.

- `npm --prefix migration run build`
  - Result: PASS.

- `node --import tsx --test test/run-reliability.test.ts`
  - Result: PASS, 6/6 tests.
  - Covered manual pre-claim compatibility with the default workspace-local `.guild/registry.db` through an automated runner regression.

- `node --import tsx --test test/warden.test.ts test/auto-canary.test.ts test/run-reliability.test.ts`
  - Result: PASS, 21/21 tests.

- `npm --prefix migration run build`
  - Result: PASS.

- `npm test`
  - Result: PASS.
  - Migration registry/guildctl: 227/227 tests passed.
  - UI: 8 files passed, 65/65 tests passed.

## Current Canary Coverage

- Autonomous mode rejects a file-backed registry DB inside the target workspace before creating a run, claiming an artifact, or invoking a worker. `:memory:` remains accepted by unit tests.
- The CLI-level fake auto canary uses an external file-backed `REGISTRY_DB`. It intentionally writes broken JS during `migrate`, writes fixed JS during `repair`, performs structured independent review through `MIGRATION_GUILD_REVIEW`, completes in 2 attempts, leaves 0 active claims, and records `auto-rework` before `auto-completed` before `arbitration-approved`.
- The warden snapshots and enforcement exclude only the active SQLite registry DB files obtained from the DB handle: the main DB plus `-wal`, `-shm`, and `-journal`. `.guild/config.yaml` and arbitrary `.guild` worker-created files remain protected.
- The automated manual pre-claim regression keeps the compatibility path for the default workspace-local `.guild/registry.db` and verifies claim finalization is not rolled back by the warden.

## External DB Requirement

Live autonomous runs require `REGISTRY_DB` outside the target workspace. A workspace-local file-backed registry is rejected with an error explaining that autonomous runs require `REGISTRY_DB` outside the target workspace, so a malicious autonomous worker cannot receive a warden exemption over the source-of-truth registry.

## Bounded Live Rootsys Canary

Workspace: `/home/frierensamacorp/projects/migration-canary-targets/live-rootsys-canary-20260715`

Artifact: `legacy-source:canary:PythonLookup`

Readiness probes exercised the failure boundaries before the final pass:

- Pytest initially created `.pytest_cache/**` and `__pycache__/**`; the warden restored those unauthorized paths and blocked the run. Worker and verifier execution were hardened with `PYTHONDONTWRITEBYTECODE=1` and `PYTEST_ADDOPTS=-p no:cacheprovider`.
- A read-only independent reviewer correctly rejected an output that claimed to be typed but lacked function annotations. The supervisor was extended with typed, budgeted `review-rejection` repair: reviewer reason reaches `remediation-agent`, then evidence and independent review are rerun before approval. Deterministic coverage proves completion in two attempts, one claim owner, and zero active claims.
- Another probe created `modern/__init__.py` outside the exact claim output and was blocked/restored. The final canary used a pre-existing empty package scaffold instead of widening the claim.

Final proof:

- The CLI was invoked with top-level `--db /home/frierensamacorp/.hermes/tmp/migration-guild-live-canary/registry-db-handoff.db` while `REGISTRY_DB` was explicitly unset and `.guild/config.yaml` pointed at the deliberately wrong workspace-local `.guild/wrong-registry.db`.
- The supervisor passed the resolved absolute `--db` path into the worker's exact registry CLI argv and overrode inherited registry environment variables. The wrong workspace-local database was never created.
- Run: `auto-c2b90e6ee844`.
- Result: `complete` in 2 attempts: producer migration, reviewer rejection, typed remediation, reverification, and approval.
- Artifact terminal status: `reviewed`.
- Both claims completed under the single owner `guildctl-auto:legacy-source:canary:PythonLookup`; 0 active claims remained.
- Authoritative verifier: `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider test_canary.py`.
- Verifier result: exit 0, 2/2 tests passed on both attempts.
- Runtime log SHA-256 values `dac9a0d2303aa123566f23a6e8f3584b99332ff2dc165886c1f5d971c70d1756` and `88288f2cbf3c58f5b9c1b421e8a0f0252e72d7d8ef154acaf691daf8fb433b66` were independently recomputed and matched their registry records.
- The read-only reviewer rejected a non-string behavioral mismatch, and the remediation agent corrected it. Independent rereview then approved: `modern lookup matches legacy behavior and verifier tests passed`.
- Arbitration decision: approved by `review-agent`.
- SQLite `integrity_check`: `ok`.
- Post-run filesystem check found no `__pycache__` paths.

## Final Full Suite and Independent Review

After all live-canary fixes:

- `npm test`: PASS.
- Migration registry/guildctl: 232/232 tests passed.
- UI: 8 files passed, 65/65 tests passed.
- Independent Codex final re-review: `VERDICT: PASS`.
- Earlier Fable review blocker (workspace-local registry collision with warden) was remediated; Fable's later service session limit prevented another invocation, so Codex performed the final post-remediation review.

No provider/API/secret values were printed or recorded in this report.
