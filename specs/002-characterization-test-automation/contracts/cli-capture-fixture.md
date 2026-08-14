# Contract: `guildctl capture-fixture`

New CLI command, modeled directly on `guildctl verify` (`migration/guildctl/commands/verify.ts`
/ `migration/guildctl/cli.ts` `program.command("verify")`).

## Invocation

```
guildctl capture-fixture --artifact <id> --seam <name> --command <cmd> [--json]
```

| Flag | Required | Meaning |
|---|---|---|
| `--artifact <id>` | yes | Artifact ID to attach the captured fixture to (per FR-003). |
| `--seam <name>` | yes | Identifier for the test seam being invoked (FR-004). |
| `--command <cmd>` | yes | The already-passing unit/invocation-level test command to run (FR-002). Explicit, not auto-discovered — see research Decision 5. |
| `--json` | no | Print the recorded evidence (or skip reason) as JSON instead of human-readable text. |

## Behavior

1. Resolves the workspace root and guild config, same as `verify` (`resolveWorkspaceRoot`,
   `resolveGuildConfig`).
2. Starts a run (`startRun`, `phase: "capture-fixture"`) and creates a run operator credential,
   matching `verify`'s pattern — the capture is verifier/tool-owned, not caller-asserted.
3. Executes `--command` in the workspace. Captures stdout/exit code as the seam's concrete
   output.
4. **On successful execution** (exit code 0): writes the fixture JSON file (per data-model.md)
   under `<evidence.output_dir>/characterization/`, computes `contentSha256`, and calls
   `addAcceptanceEvidence` internally (bypassing the public caller-facing guard — this is the
   tool-owned recording path, exactly as `runVerify` records `runtime` evidence) with
   `evidence_type: "characterization-fixture"`, `pass: 1`.
5. **On failed execution** (non-zero exit, seam errored, or seam requires a runtime the
   environment can't provide): records nothing as a *fixture*, and instead prints/returns a
   skip result naming the artifact and the reason (FR-005) — this is a skip, not a failing
   evidence row, matching Edge Cases: "capture should skip... rather than fail silently" and
   "not attempt a partial or fabricated capture."
6. Finishes the run (`finishRun`) with an exit code reflecting whether capture succeeded or was
   skipped.

## Output (human-readable)

```
Captured characterization-fixture for artifact <id> (seam: <seam>)
  evidence: <evidence_id>
  content sha256: <hash>
```

or, on skip:

```
Skipped fixture capture for artifact <id> (seam: <seam>): <reason>
```

## Output (`--json`)

```json
{
  "captured": true,
  "evidenceId": "...",
  "artifactId": "...",
  "seam": "...",
  "contentSha256": "..."
}
```

or

```json
{
  "captured": false,
  "artifactId": "...",
  "seam": "...",
  "reason": "..."
}
```

## Errors

- Unknown `--artifact` → same `RegistryError` behavior as every other evidence/verify command
  (`assertArtifactExists`).
- Missing workspace/db → same `assertDbExists` guard used by every other `guildctl` command.
