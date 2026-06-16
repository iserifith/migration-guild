import React from "react";
import type { Artifact, TimeDisplayMode } from "../types";
import { useEvents } from "../hooks";
import { formatTimestamp } from "../format";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

export default function ArtifactDetail({
  artifact,
  onClose,
  timeMode,
}: {
  artifact: Artifact;
  onClose: () => void;
  timeMode: TimeDisplayMode;
}) {
  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    reload: reloadEvents,
  } = useEvents(artifact.id);

  const fields: [string, string][] = [
    ["ID", artifact.id],
    ["Kind", artifact.kind],
    ["Role", artifact.role ?? "-"],
    ["Module", artifact.module ?? "-"],
    ["Wave", artifact.wave != null ? `wave ${artifact.wave}` : "-"],
    ["Status",     artifact.status],
    ["Path",       artifact.path],
    ["Data path",  artifact.data_path ?? "-"],
    ["Created",    formatTimestamp(artifact.created_at, timeMode)],
    ["Updated",    formatTimestamp(artifact.updated_at, timeMode)],
  ];

  return (
    <div className="detail">
      <button className="close-btn" onClick={onClose}>×</button>
      <h2>{artifact.id}</h2>

      <div className="detail-grid">
        {fields.map(([label, value]) => (
          <React.Fragment key={label}>
            <span className="detail-label">{label}</span>
            <span className="detail-value">{value}</span>
          </React.Fragment>
        ))}
      </div>

      <div className="events">
        <h3>Event log</h3>
        {eventsLoading ? (
          <LoadingState compact resource="event log" />
        ) : eventsError ? (
          <ErrorState
            compact
            resource="event log"
            error={eventsError}
            onRetry={reloadEvents}
          />
        ) : events.length === 0 ? (
          <EmptyState compact title="No events yet." />
        ) : events.map((e) => (
          <div key={e.id} className="event-item">
            <span className="event-type">{e.event_type}</span>
            <span className="event-agent">{e.agent ?? "-"}</span>
            <span className="event-note">{e.note ?? ""}</span>
            <span className="event-time">{formatTimestamp(e.created_at, timeMode)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
