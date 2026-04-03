import React from "react";
import type { Artifact } from "../types";
import { useEvents } from "../hooks";

export default function ArtifactDetail({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const { events, loading: eventsLoading } = useEvents(artifact.id);

  const fields: [string, string][] = [
    ["ID",         artifact.id],
    ["Kind",       artifact.kind],
    ["Role",       artifact.role ?? "—"],
    ["Module",     artifact.module ?? "—"],
    ["Wave",       artifact.wave != null ? `wave ${artifact.wave}` : "—"],
    ["Status",     artifact.status],
    ["Path",       artifact.path],
    ["Data path",  artifact.data_path ?? "—"],
    ["Created",    artifact.created_at],
    ["Updated",    artifact.updated_at],
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
          <div style={{ color: "#444", fontSize: 12, padding: "8px 0" }}>Loading events…</div>
        ) : events.length === 0 ? (
          <div style={{ color: "#444", fontSize: 12, padding: "8px 0" }}>No events yet.</div>
        ) : events.map((e) => (
          <div key={e.id} className="event-item">
            <span className="event-type">{e.event_type}</span>
            <span className="event-agent">{e.agent ?? "—"}</span>
            <span className="event-note">{e.note ?? ""}</span>
            <span className="event-time">{e.created_at}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
