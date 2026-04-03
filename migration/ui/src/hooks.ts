/**
 * React hooks for fetching registry data.
 *
 * All data-fetching logic lives here so components stay pure and testable.
 * Each hook manages its own loading/error state and exposes a `reload` callback
 * so any component can trigger a manual refresh.
 */

import { useState, useEffect, useCallback } from "react";
import { fetchArtifacts, fetchStatus, fetchEvents } from "./api";
import type { ArtifactQuery } from "./api";
import type { Artifact, ArtifactEvent, StatusResponse } from "./types";

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
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Stable key so the effect only fires when query values actually change.
  const queryKey = JSON.stringify(query);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchArtifacts(JSON.parse(queryKey) as ArtifactQuery)
      .then((data) => {
        setArtifacts(data);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  useEffect(() => {
    load();
  }, [load]);

  return { artifacts, loading, error, reload: load };
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
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchStatus()
      .then((data) => {
        setStatus(data);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { status, loading, error, reload: load };
}

// ── useEvents ─────────────────────────────────────────────────────────────────

export interface UseEventsResult {
  events: ArtifactEvent[];
  loading: boolean;
  error: Error | null;
}

/** Fetches the event log for a single artifact, refetching when id changes. */
export function useEvents(artifactId: string): UseEventsResult {
  const [events, setEvents] = useState<ArtifactEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchEvents(artifactId)
      .then((data) => {
        if (!cancelled) {
          setEvents(data);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  return { events, loading, error };
}

// ── useRegistryData ───────────────────────────────────────────────────────────

export interface UseRegistryDataResult {
  artifacts: Artifact[];
  status: StatusResponse | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Combined hook for the main app shell — fetches artifacts + status in
 * parallel and exposes a single `reload` callback that refreshes both.
 */
export function useRegistryData(): UseRegistryDataResult {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchArtifacts(), fetchStatus()])
      .then(([arts, stat]) => {
        setArtifacts(arts);
        setStatus(stat);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { artifacts, status, loading, error, reload: load };
}
