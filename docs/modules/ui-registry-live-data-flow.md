# The UI ↔ Registry Live Data Flow

## Purpose and Overview

The Migration Guild requires live observability into the state of the migration pipeline. As autonomous agents continuously claim artifacts, generate code, and record evidence into the local SQLite registry, the React frontend must remain in sync to display active sessions, wave progress, and event logs.

This document traces the complete live data flow: from how the backend watches the SQLite database for new events, to how the UI fetches and binds this data into React components.

A core architectural decision across this entire flow is **Polling vs. WebSockets**. Rather than running a stateful WebSocket server that pushes events, the system relies exclusively on pull-based polling. Because the registry is a local SQLite database, frequent reads are extremely cheap, and stateless HTTP polling drastically simplifies the deployment topology—there are no long-lived connections to manage or connection-drop edge cases to handle.

## Architecture and Data Path

The live data flow spans four primary boundaries:
1. **Backend Event Poller (`migration/guildctl/poller.ts`)**: Watches the SQLite database for new event rows using a cursor-based approach.
2. **Backend HTTP Server (`migration/registry/commands/serve.ts`)**: Exposes REST endpoints (e.g., `/api/events`, `/api/artifacts`) to query the registry.
3. **Frontend API Client (`migration/ui/src/api.ts`)**: Typed fetch wrappers that define the client-server contract.
4. **Frontend React Hooks (`migration/ui/src/hooks.ts`)**: Manages the polling lifecycle, request racing, and exposes data/status to the UI components.

## 1. The Backend: Polling the Database

The foundational mechanism for tracking live updates is the `startPolling` function in `migration/guildctl/poller.ts`. While the HTTP server serves full snapshots of data to the UI on demand, `startPolling` exemplifies how the system efficiently queries for *new* activity without scanning the whole database.

### The Watermark Cursor

`startPolling` maintains a high-water mark cursor (`lastTs`) initialized to the current time when the poller starts:

```typescript
let lastTs = new Date()
  .toISOString()
  .replace("T", " ")
  .replace(/\.\d+Z$/, "");
```

Every interval tick (defaulting to 2000ms), it executes a compiled `better-sqlite3` prepared statement:

```sql
SELECT e.event_id, e.ts, e.artifact_id, e.type, e.agent, e.summary,
       a.path, a.module
FROM events e
JOIN artifacts a ON e.artifact_id = a.id
WHERE e.ts > ?
ORDER BY e.ts ASC
```

### Batching and Delivery

When the query returns rows, the cursor is advanced to the timestamp of the last row in the batch (`lastTs = rows[rows.length - 1]!.ts`), and the entire batch of `RegistryEvent` objects is delivered to the provided `onChange` callback. By joining `events` with `artifacts`, it immediately provides the rich context (file path and module) needed for UI or CLI display without requiring an N+1 lookup.

When the caller wants to stop listening, they simply call the returned cleanup function, which invokes `clearInterval(handle)`.

## 2. The Frontend: Fetch Client

On the UI side, all HTTP interactions are routed through a single typed API module (`migration/ui/src/api.ts`). This ensures consistent URL building and error handling.

For example, fetching events for a specific artifact is encapsulated as:

```typescript
export function fetchEvents({ id, limit }: EventQuery): Promise<ArtifactEvent[]> {
  return get<ArtifactEvent[]>(buildUrl("/api/events", { id, limit }));
}
```

The `get<T>` helper is a thin wrapper over the native `fetch` API. It checks `res.ok` and throws an error if the HTTP status is not 2xx, ensuring that network failures or server errors reject the promise.

## 3. The Frontend: React Hooks and Polling Lifecycle

React components do not interact with `api.ts` directly. Instead, they consume custom hooks defined in `migration/ui/src/hooks.ts`. These hooks manage the component-level polling lifecycle, loading states, and error handling.

### The `useLoadableData` Engine

At the core of the UI's polling strategy is the internal `useLoadableData` hook. It manages the boilerplate of asynchronous data fetching:

- **State Exposure:** It returns an object containing `{ data, loading, error, reload }`.
- **Request Racing Prevention:** It uses a `requestIdRef` to prevent race conditions where an older, slower network response overwrites a newer, faster one. If the `requestId` changes while a fetch is in flight, the promise resolution is ignored.
- **Polling Lifecycle:** It uses a `useEffect` to start a `setInterval` loop if `pollIntervalMs` is provided.

```typescript
useEffect(() => {
  load(); // Initial fetch
  if (!pollIntervalMs) return;
  const timer = window.setInterval(load, pollIntervalMs);
  return () => window.clearInterval(timer); // Cleanup on unmount
}, [load, pollIntervalMs]);
```

### Feature Hooks

Specific data slices are exposed via dedicated feature hooks that wrap `useLoadableData`. Some hooks fetch once, while others poll continuously.

For instance, `useEvents` fetches the event log for a single artifact and polls every 5 seconds (5,000ms):

```typescript
export function useEvents(artifactId: string): UseEventsResult {
  const state = useLoadableData(
    () => fetchEvents({ id: artifactId }),
    [] as ArtifactEvent[],
    [artifactId], // Refetch instantly if artifactId changes
    5_000,        // pollIntervalMs
  );
  return { events: state.data, loading: state.loading, error: state.error, reload: state.reload };
}
```

Other hooks like `useArtifacts` or `useStatus` do not poll automatically on an interval. Instead, they are orchestrated by a master `useRegistryData` hook. The `useRegistryData` hook aggregates all baseline registry queries into a single shell context and exposes a unified `reload()` callback.

## Invariants and Gotchas

- **Socket vs. Polling Decision:** The system consciously avoids WebSockets. The backend API (`serve.ts`) is completely stateless. The UI asks for data; the server queries SQLite and responds. This makes the frontend resilient to backend restarts—if the server goes down, the next poll just fails, and when it comes back up, polling naturally succeeds again.
- **Failure and Backoff Behavior:** The UI polling implementation (`useLoadableData`) is naive by design. There is no exponential backoff. If an API request fails, the `error` state is populated (allowing the UI to show an error indicator), but `setInterval` keeps ticking. It will blindly attempt to fetch again on the next interval. Since the backend is local, this aggressive retry behavior is cheap and ensures instant recovery once the server is available.
- **Cache Invalidation:** The hooks do not use a complex caching layer (like React Query or SWR). Cache invalidation is handled purely by the dependency array (e.g., `[artifactId]`). If a parent component changes the ID, the hook instantly discards the old timer, resets the data, and fetches fresh state.

## Extension Points

If you need to expose a new real-time slice of registry data to the UI:
1. Define the SQL query in `migration/registry/commands/queries.ts`.
2. Expose a new HTTP endpoint in `migration/registry/commands/serve.ts`.
3. Add a typed fetch wrapper in `migration/ui/src/api.ts`.
4. Create a new `useX` hook in `migration/ui/src/hooks.ts` wrapping `useLoadableData`, passing `pollIntervalMs` if it requires live updates.