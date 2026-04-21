import type { Artifact } from "../App";

const STATUS_COLORS: Record<string, string> = {
  pending:       "#94a3b8",
  planned:       "#60a5fa",
  "in-progress": "#f59e0b",
  "tests-written":"#34d399",
  migrated:      "#4ade80",
  reviewed:      "#c084fc",
  "needs-rework":"#f87171",
};

export default function WavePlan({ artifacts }: { artifacts: Artifact[] }) {
  const waves = new Map<number, Artifact[]>();
  const noWave: Artifact[] = [];

  for (const a of artifacts) {
    if (a.wave == null) { noWave.push(a); continue; }
    if (!waves.has(a.wave)) waves.set(a.wave, []);
    waves.get(a.wave)!.push(a);
  }

  const sorted = [...waves.entries()].sort(([a], [b]) => a - b);

  if (sorted.length === 0 && noWave.length === 0) {
    return <div className="empty">No artifacts registered yet. Run inventory first.</div>;
  }

  return (
    <div className="wave-grid">
      {sorted.map(([wave, items]) => {
        const byStatus: Record<string, number> = {};
        for (const a of items) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
        const done = items.filter((a) => ["migrated","reviewed","completed","skipped"].includes(a.status)).length;
        const pct = Math.round((done / items.length) * 100);

        return (
          <div key={wave} className="wave-card">
            <div className="wave-header">
              <span className="wave-label">Wave {wave}</span>
              <span className="wave-total">{items.length} files · {pct}% done</span>
            </div>
            <div style={{ height: 6, background: "#252525", borderRadius: 3, marginBottom: 10, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: "#4ade80", borderRadius: 3, transition: "width .3s" }} />
            </div>
            <div className="wave-bars">
              {Object.entries(byStatus).map(([s, n]) => (
                <span key={s} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "#1e1e1e", color: STATUS_COLORS[s] ?? "#888", marginRight: 4 }}>
                  {n} {s}
                </span>
              ))}
            </div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 2 }}>
              {items.map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                  <span style={{ color: STATUS_COLORS[a.status] ?? "#888", minWidth: 8 }}>●</span>
                  <span style={{ fontFamily: "monospace", color: "#666" }}>{a.path}</span>
                  <span style={{ marginLeft: "auto", color: "#444" }}>{a.role ?? ""}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {noWave.length > 0 && (
        <div className="wave-card">
          <div className="wave-header">
            <span className="wave-label" style={{ color: "#555" }}>No wave assigned</span>
            <span className="wave-total">{noWave.length} files</span>
          </div>
          {noWave.map((a) => (
            <div key={a.id} style={{ fontSize: 11, color: "#444", fontFamily: "monospace", padding: "2px 0" }}>{a.path}</div>
          ))}
        </div>
      )}
    </div>
  );
}
