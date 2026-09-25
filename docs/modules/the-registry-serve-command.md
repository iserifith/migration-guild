# The Registry Serve Command

## Purpose and Overview

The Migration Guild provides a local web-based UI (`migration/ui`) to help operators visualize the current state of the migration pipeline. The backend that powers this UI is the `serve` command of the registry CLI, implemented in `migration/registry/commands/serve.ts`.

The `serve` command starts an HTTP server on a specified port (default 3322). It serves two primary functions:
1. It hosts a REST API connected directly to the local SQLite registry database, providing endpoints that power the frontend UI.
2. It statically serves the compiled frontend SPA (Single Page Application) assets from the `migration/ui-dist/` directory.

A key design principle of `serve.ts` is that it acts strictly as a thin HTTP dispatcher. It contains almost zero business logic or raw SQL queries. Instead, it delegates all database interactions to dedicated query functions in `migration/registry/commands/queries.ts`.

## Architecture and Scope

The serve architecture is built natively on top of Node.js `http.createServer`. It does not rely on heavy frameworks like Express or Fastify. This keeps the registry CLI lightweight and quick to start.

- **The HTTP Dispatcher (`serve.ts`)**: Contains route matching logic (`if (p === "/api/artifacts") { ... }`), parses query parameters from URLs, reads JSON bodies for POST requests, and translates internal query results into HTTP 200 JSON responses or HTTP 400 text responses.
- **The Query Layer (`queries.ts`)**: Defines functions like `queryArtifactsForUI`, `queryStatusSummary`, and `queryWavePlanForUI`. These functions accept specific parameter objects, execute the raw SQLite queries, format the results, and return them.
- **The UI Distribution (`ui-dist`)**: The server looks for compiled UI assets in `migration/ui-dist/` (which is one level up from the `registry/dist/` build output folder).

## Step-by-Step Flow and Mechanics

When `serve.ts:startServer` is invoked, it starts the `http.createServer` callback for every incoming request.

1. **Route Matching**: The URL path is parsed (`const p = url.pathname;`). The server checks if it matches any defined `/api/*` endpoints.

2. **Data Aggregation via Queries**: If the path matches an endpoint, `serve.ts` extracts any required parameters from the URL's query string (using helpers like `numberParam`). It then calls the corresponding query function.
   - For example, `GET /api/artifacts` extracts `status`, `module`, `kind`, and `tier` query parameters, then passes them to `queryArtifactsForUI(db, { ... })`.

3. **HTTP Response Formatting**: The result of the query function is serialized into JSON using the `json(res, data)` helper, which sets the `Content-Type: application/json` header and writes the body. Errors are handled gracefully using `jsonError(res, status, message)` which responds with plain-text error messages.

4. **Static Serving and SPA Fallback**: If the URL path does not match any API endpoints, the server assumes it's a request for a static asset.
   - The `serveStatic(res, filePath)` helper checks if the requested file exists in `UI_DIR` and serves it with the correct MIME type (e.g., `text/html`, `application/javascript`, `text/css`).
   - If the requested path is exactly `/` or `/index.html`, it explicitly attempts to serve `index.html`. If it's missing, it returns a 404 error advising the user to build the UI: `UI not built. Run from the workspace root: npm --prefix migration/ui run build`.
   - For all other non-API paths, if the requested file doesn't exist, it applies an **SPA Fallback**. It attempts to serve `index.html` again. This allows the frontend React router to take over and handle client-side routing. If `index.html` still isn't found, it returns a standard 404.

## Invariants and Edge Cases

- **Thin Dispatcher**: `serve.ts` explicitly avoids writing raw SQL. If new API data is needed, a new helper must be created in `queries.ts`.
- **JSON Body Parsing**: `serve.ts` implements a minimal, manual JSON body reader (`readJsonBody`) for POST requests (specifically added for the `/api/approvals/<id>/decision` endpoint). To prevent denial-of-service attacks, it enforces a strict 1MB size limit (`if (raw.length > 1_000_000)`).
- **Approval Operator Default**: When a decision is submitted via the UI dashboard (`POST /api/approvals/<id>/decision`), if the request body lacks an `operator` field, the API explicitly defaults to `DASHBOARD_OPERATOR_ID` (`"mission-control"`). This mirrors the CLI's `"guildctl-approve"` default.
- **Log Streaming**: The `/api/runs/<id>/log` endpoint does not use JSON. It fetches the `log_file` path from the `runs` table, ensures the file exists on disk, and directly pipes the `fs.createReadStream` to the HTTP response with `Content-Type: text/plain; charset=utf-8`. If the run or file is missing, it returns a plain-text 404.

## Extension Points

- To add a new API endpoint, insert an `if (p === "/api/new-endpoint")` block in `migration/registry/commands/serve.ts:startServer`. Ensure the data retrieval logic is implemented as a new exported function in `migration/registry/commands/queries.ts`.
- The `MIME` dictionary in `serve.ts` can be extended if the frontend build starts producing new asset types (e.g., fonts like `.woff2`) that require specific `Content-Type` headers.