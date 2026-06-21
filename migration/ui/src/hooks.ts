/**
 * React hooks for fetching registry data.
 *
 * All data-fetching logic lives here so components stay pure and testable.
 * Each hook manages its own loading/error state and exposes a `reload` callback
 * so any component can trigger a manual refresh.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
} from "react";
import {
  fetchArtifacts,
  fetchBlockers,
  fetchEvents,
  fetchIssues,
  fetchRunLog,
  fetchRuns,
  fetchSessions,
  fetchStatus,
  fetchWavePlan,
} from "./api";
import type { ArtifactQuery } from "./api";
import type {
  Artifact,
  ArtifactEvent,
  BlockerListResult,
  BlockerQuery,
  BlockerEntry,
  IssueListResult,
  IssueQuery,
  IssueEntry,
  RunEntry,
  RunFilters,
  RunListResult,
  RunQuery,
  SessionFilters,
  SessionListResult,
  SessionQuery,
  SessionEntry,
  StatusResponse,
  WavePlanEntry,
} from "./types";

interface LoadableState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

function useLoadableData<T>(
  loader: () => Promise<T>,
  initialData: T,
  deps: DependencyList,
): LoadableState<T> {
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setData(result);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, reload: load };
}

// ── useArtifacts ──────────────────────────────────────────────────────────────

export interface UseArtifactsResult {
  artifacts: Artifact[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Fetches the artifact list, re-fetching whenever `query` changes.
 * Query identity is compared by value (JSON-serialised) to avoid unnecessary
 * re-renders when a parent passes a new object literal on every render.
 */
export function useArtifacts(query: ArtifactQuery = {}): UseArtifactsResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchArtifacts(JSON.parse(queryKey) as ArtifactQuery),
    [] as Artifact[],
    [queryKey],
  );

  return {
    artifacts: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

// ── useStatus ─────────────────────────────────────────────────────────────────

export interface UseStatusResult {
  status: StatusResponse | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** Fetches the registry status summary (file counts + operator state). */
export function useStatus(): UseStatusResult {
  const state = useLoadableData(
    () => fetchStatus(),
    null as StatusResponse | null,
    [],
  );

  return {
    status: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

// ── useEvents ─────────────────────────────────────────────────────────────────

export interface UseEventsResult {
  events: ArtifactEvent[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** Fetches the event log for a single artifact, refetching when id changes. */
export function useEvents(artifactId: string): UseEventsResult {
  const state = useLoadableData(
    () => fetchEvents({ id: artifactId }),
    [] as ArtifactEvent[],
    [artifactId],
  );

  return {
    events: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

// ── Feature hooks ─────────────────────────────────────────────────────────────

export interface UseWavePlanResult {
  wavePlan: WavePlanEntry[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useWavePlan(): UseWavePlanResult {
  const state = useLoadableData(
    () => fetchWavePlan(),
    [] as WavePlanEntry[],
    [],
  );

  return {
    wavePlan: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseSessionsResult {
  sessions: SessionEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: SessionFilters;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useSessions(query: SessionQuery = {}): UseSessionsResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchSessions(JSON.parse(queryKey) as SessionQuery),
    {
      items: [] as SessionEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies SessionListResult,
    [queryKey],
  );

  return {
    sessions: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    availableFilters: state.data.available_filters,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseBlockersResult {
  blockers: BlockerEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useBlockers(query: BlockerQuery = {}): UseBlockersResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchBlockers(JSON.parse(queryKey) as BlockerQuery),
    {
      items: [] as BlockerEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies BlockerListResult,
    [queryKey],
  );

  return {
    blockers: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseIssuesResult {
  issues: IssueEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: IssueListResult["available_filters"];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useIssues(query: IssueQuery = {}): UseIssuesResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchIssues(JSON.parse(queryKey) as IssueQuery),
    {
      items: [] as IssueEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies IssueListResult,
    [queryKey],
  );

  return {
    issues: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    availableFilters: state.data.available_filters,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseRunsResult {
  runs: RunEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: RunFilters;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useRuns(query: RunQuery = {}): UseRunsResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchRuns(JSON.parse(queryKey) as RunQuery),
    {
      items: [] as RunEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies RunListResult,
    [queryKey],
  );

  return {
    runs: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    availableFilters: state.data.available_filters,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseRunLogResult {
  log: string | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useRunLog(runId: string | null): UseRunLogResult {
  const [log, setLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    if (!runId) {
      setLog(null);
      setLoading(false);
      setError(null);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    fetchRunLog(runId)
      .then((data) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setLog(data);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  return { log, loading, error, reload: load };
}

// ── useRegistryData ───────────────────────────────────────────────────────────

export interface UseRegistryDataResult {
  artifacts: UseArtifactsResult;
  status: UseStatusResult;
  wavePlan: UseWavePlanResult;
  sessions: UseSessionsResult;
  blockers: UseBlockersResult;
  issues: UseIssuesResult;
  runs: UseRunsResult;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export interface UseRegistryDataQueries {
  sessions?: SessionQuery;
  blockers?: BlockerQuery;
  issues?: IssueQuery;
  runs?: RunQuery;
}

/**
 * Combined hook for the main app shell — fetches baseline registry data and the
 * active monitoring slices, exposing a single `reload` callback that refreshes
 * all of them.
 */
export function useRegistryData(
  queries: UseRegistryDataQueries = {},
): UseRegistryDataResult {
  const artifacts = useArtifacts();
  const status = useStatus();
  const wavePlan = useWavePlan();
  const sessions = useSessions(queries.sessions);
  const blockers = useBlockers(queries.blockers);
  const issues = useIssues(queries.issues);
  const runs = useRuns(queries.runs);

  const reload = useCallback(() => {
    artifacts.reload();
    status.reload();
    wavePlan.reload();
    sessions.reload();
    blockers.reload();
    issues.reload();
    runs.reload();
  }, [
    artifacts.reload,
    status.reload,
    wavePlan.reload,
    sessions.reload,
    blockers.reload,
    issues.reload,
    runs.reload,
  ]);

  return {
    artifacts,
    status,
    wavePlan,
    sessions,
    blockers,
    issues,
    runs,
    loading: artifacts.loading || status.loading,
    error: artifacts.error ?? status.error,
    reload,
  };
}
