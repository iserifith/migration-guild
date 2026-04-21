import { useEffect, useState } from "react";
import type { Artifact } from "../App";

type Event = {
  id: string;
  event_type: string;
  agent: string | null;
  note: string | null;
  created_at: string;
};

export default function ArtifactDetail({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    fetch(`/api/events?id=${encodeURIComponent(artifact.id)}`)
      .then((r) => r.json())
      .then(setEvents);
  }, [artifact.id]);

  const fields: [string, string][] = [
    ["ID",         artifact.id],
    ["Kind",       artifact.kind],
    ["Role",       artifact.role ?? "—"],
    ["Module",     artifact.module ?? "—"],
    ["Wave",       artifact.wave != null ? `wave ${artifact.wave}` : "—"],
    ["Status",     artifact.status],
    ["Path",       artifact.path],
    ["Data path",  artifact.data_path],
    ["Created",    artifact.created_at],
    ["Updated",    artifact.updated_at],
  ];

  return (
    <div className="detail">
      <button className="close-btn" onClick={onClose}>×</button>
      <h2>{artifact.id}</h2>

      <div className="detail-grid">
        {fields.map(([label, value]) => (
          <>
            <span className="detail-label">{label}</span>
            <span className="detail-value">{value}</span>
          </>
        ))}
      </div>

      <div className="events">
        <h3>Event log</h3>
        {events.length === 0 ? (
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
