import { useState } from "react";
import type { Artifact, TimeDisplayMode } from "../types";
import { STATUS_FILTER_OPTIONS, KIND_FILTER_OPTIONS } from "../constants";
import ArtifactDetail from "./ArtifactDetail";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

export default function ArtifactList({
  artifacts,
  loading,
  error,
  onRetry,
  timeMode,
}: {
  artifacts: Artifact[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  timeMode: TimeDisplayMode;
}) {
  const [filterStatus, setFilterStatus] = useState("");
  const [filterModule, setFilterModule] = useState("");
  const [filterKind, setFilterKind] = useState("");
  const [selected, setSelected] = useState<Artifact | null>(null);

  if (loading) {
    return <LoadingState resource="artifacts" />;
  }

  if (error) {
    return <ErrorState resource="artifacts" error={error} onRetry={onRetry} />;
  }

  if (artifacts.length === 0) {
    return (
      <EmptyState
        title="No artifacts found."
        detail="Artifacts will appear here once the registry has data to inspect."
        actionLabel="Reload artifacts"
        onAction={onRetry}
      />
    );
  }

  const modules = [
    "",
    ...(Array.from(new Set(artifacts.map((a) => a.module).filter(Boolean))) as string[]),
  ];

  const filtered = artifacts.filter((a) =>
    (!filterStatus || a.status === filterStatus) &&
    (!filterModule || a.module === filterModule) &&
    (!filterKind || a.kind === filterKind),
  );

  return (
    <>
      <div className="filters">
        <select
          aria-label="Artifact status filter"
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Artifact module filter"
          className="filter-select"
          value={filterModule}
          onChange={(e) => setFilterModule(e.target.value)}
        >
          {modules.map((m) => (
            <option key={m} value={m}>
              {m || "All modules"}
            </option>
          ))}
        </select>
        <select
          aria-label="Artifact kind filter"
          className="filter-select"
          value={filterKind}
          onChange={(e) => setFilterKind(e.target.value)}
        >
          {KIND_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="filter-meta">
          {filtered.length} / {artifacts.length}
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Role</th>
              <th>Module</th>
              <th>Wave</th>
              <th>Status</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No artifacts match filters.
                </td>
              </tr>
            )}
            {filtered.map((a) => (
              <tr
                key={a.id}
                className="clickable"
                onClick={() => setSelected(a === selected ? null : a)}
              >
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{a.id}</td>
                <td>
                  <span style={{ color: "#94a3b8", fontSize: 12 }}>{a.role ?? "-"}</span>
                </td>
                <td>
                  <span className="module-tag">{a.module ?? "-"}</span>
                </td>
                <td>
                  {a.wave != null ? (
                    <span className="wave-chip">wave {a.wave}</span>
                  ) : (
                    <span style={{ color: "#333" }}>-</span>
                  )}
                </td>
                <td>
                  <span className={`badge ${a.status}`}>{a.status}</span>
                </td>
                <td>
                  <span className="path">{a.path}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <ArtifactDetail
          artifact={selected}
          onClose={() => setSelected(null)}
          timeMode={timeMode}
        />
      )}
    </>
  );
}
