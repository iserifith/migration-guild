import { DONE_STATUSES, STATUS_COLOR_FALLBACK, STATUS_COLORS } from "../constants";
import type { WavePlanEntry } from "../types";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

export default function WavePlan({
  entries,
  loading,
  error,
  onRetry,
}: {
  entries: WavePlanEntry[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const sorted = [...entries].sort((a, b) => a.wave - b.wave);

  if (loading) {
    return <LoadingState resource="wave plan" />;
  }

  if (error) {
    return <ErrorState resource="wave plan" error={error} onRetry={onRetry} />;
  }

  if (sorted.length === 0) {
    return (
      <EmptyState
        title="No wave plan data available."
        actionLabel="Reload wave plan"
        onAction={onRetry}
      />
    );
  }

  return (
    <div className="wave-grid">
      {sorted.map((entry) => {
        const done = DONE_STATUSES.reduce(
          (total, status) => total + (entry.by_status[status] ?? 0),
          0,
        );
        const pct = entry.total === 0 ? 0 : Math.round((done / entry.total) * 100);

        return (
          <div key={entry.wave} className="wave-card">
            <div className="wave-header">
              <span className="wave-label">Wave {entry.wave}</span>
              <span className="wave-total">
                {entry.total} files · {pct}% done
              </span>
            </div>
            <div
              style={{
                height: 6,
                background: "#252525",
                borderRadius: 3,
                marginBottom: 10,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: "#4ade80",
                  borderRadius: 3,
                  transition: "width .3s",
                }}
              />
            </div>
            <div className="wave-bars">
              {Object.entries(entry.by_status).map(([status, count]) => (
                <span
                  key={status}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: "#1e1e1e",
                    color: STATUS_COLORS[status] ?? STATUS_COLOR_FALLBACK,
                    marginRight: 4,
                  }}
                >
                  {count} {status}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
