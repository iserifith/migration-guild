import { useState, useEffect } from "react";
import ArtifactList from "./components/ArtifactList";
import WavePlan from "./components/WavePlan";

export type Artifact = {
  id: string;
  kind: string;
  path: string;
  module: string | null;
  role: string | null;
  status: string;
  wave: number | null;
  data_path: string;
  created_at: string;
  updated_at: string;
};

export type StatusSummary = {
  files: { total: number; completed: number; in_progress: number; by_status: Record<string, number> };
  current_focus: string | null;
  next: string | null;
};

const TABS = ["Artifacts", "Wave Plan"] as const;
type Tab = typeof TABS[number];

export default function App() {
  const [tab, setTab] = useState<Tab>("Artifacts");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/artifacts").then((r) => r.json()),
      fetch("/api/status").then((r) => r.json()),
    ]).then(([arts, stat]) => {
      setArtifacts(arts);
      setStatus(stat);
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, []);

  const byStatus = status?.files.by_status ?? {};

  return (
    <div className="layout">
      <header className="header">
        <h1>Migration Guild</h1>
        <span className="sep">›</span>
        <span className="project">registry inspector</span>
        <div className="stats">
          {Object.entries(byStatus).map(([s, n]) => (
            <span key={s} className={`stat ${s}`}>{n} {s}</span>
          ))}
        </div>
        <button onClick={load} style={{ marginLeft: 8, background: "none", border: "1px solid #333", color: "#888", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>
          ↻ refresh
        </button>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </nav>

      <main className="main">
        {loading ? (
          <div className="loading">Loading…</div>
        ) : tab === "Artifacts" ? (
          <ArtifactList artifacts={artifacts} />
        ) : (
          <WavePlan artifacts={artifacts} />
        )}
      </main>
    </div>
  );
}
