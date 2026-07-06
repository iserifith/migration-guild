---
description: "Build the Migration Guild distributable from this clone, then install it into an external test workspace."
---

Prepare a fresh external test workspace using this Migration Guild repository clone.

Inputs:
- `workspace`: absolute path to the test workspace
- `legacy`: GitHub URL to clone into `legacy/`, or a local filesystem path to copy into `legacy/`

If either input is missing, stop and ask for it before making changes.

Workflow:

1. Confirm the current directory is the Migration Guild source repository.
2. Validate `${workspace}`:
   - it must be an absolute path
   - it must not be this repository root
   - it must not be inside this repository
   - create it if it does not exist yet
3. Validate `${legacy}`:
   - if it looks like a GitHub URL, treat it as a clone source
   - otherwise require it to exist as a local path
   - fail clearly if it is neither
4. From this repository clone, install build dependencies:
   ```bash
   npm install
   cd migration && npm install && cd ..
   ```
5. Build the distributable kit:
   ```bash
   npm run build:dist
   ```
   Confirm `dist/migration-guild-kit.tar.gz` exists before continuing.
6. Install the built kit into `${workspace}` from the tarball:
   - unpack the tarball outside this repository
   - run the packaged `setup.js` from the workspace directory
   - pass `--framework "Spring Boot 3.x"`
   - pass `--legacy-url "${legacy}"` when `${legacy}` is a GitHub URL
   - otherwise pass `--legacy-path "${legacy}"`
7. In `${workspace}/migration`, install the runtime dependencies:
   ```bash
   npm install
   ```
8. Report:
   - the tarball path used
   - the workspace path
   - whether `legacy/` came from a GitHub URL or a local path
   - any exact blocking error if the flow did not complete

Rules:
- Use an external workspace only.
- Do not install into this repository root.
- Do not recreate `legacy/` or `modern/` under this repository.
- Do not silently continue after failed install or build steps.
- Clean up temporary extraction directories when finished.
