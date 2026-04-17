import { useMemo, useState } from "react";
import type { CostSummary } from "../types";
import { formatCurrency, formatNumber } from "../format";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

export default function CostView({
  cost,
  loading,
  error,
  onRetry,
}: {
  cost: CostSummary | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const [modelQuery, setModelQuery] = useState("");
  const [sortBy, setSortBy] = useState("cost");

  const filteredRows = useMemo(() => {
    if (!cost) {
      return [];
    }

    const normalized = modelQuery.trim().toLowerCase();
    const next = cost.by_model.filter((row) =>
      !normalized || row.model.toLowerCase().includes(normalized),
    );

    next.sort((left, right) => {
      if (sortBy === "calls") {
        return right.calls - left.calls;
      }

      if (sortBy === "tokens") {
        return right.tokens_in + right.tokens_out - (left.tokens_in + left.tokens_out);
      }

      if (sortBy === "model") {
        return left.model.localeCompare(right.model);
      }

      return right.cost_usd - left.cost_usd;
    });

    return next;
  }, [cost, modelQuery, sortBy]);

  if (loading) {
    return <LoadingState resource="cost summary" />;
  }

  if (error) {
    return <ErrorState resource="cost summary" error={error} onRetry={onRetry} />;
  }

  if (!cost) {
    return (
      <EmptyState
        title="No cost data available."
        actionLabel="Reload cost summary"
        onAction={onRetry}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        }}
      >
        <div className="wave-card">
          <div className="wave-header">
            <span className="wave-label">Calls</span>
            <span className="wave-total">{formatNumber(cost.total_calls)}</span>
          </div>
        </div>
        <div className="wave-card">
          <div className="wave-header">
            <span className="wave-label">Tokens in</span>
            <span className="wave-total">{formatNumber(cost.total_tokens_in)}</span>
          </div>
        </div>
        <div className="wave-card">
          <div className="wave-header">
            <span className="wave-label">Tokens out</span>
            <span className="wave-total">{formatNumber(cost.total_tokens_out)}</span>
          </div>
        </div>
        <div className="wave-card">
          <div className="wave-header">
            <span className="wave-label">Cost</span>
            <span className="wave-total">{formatCurrency(cost.total_cost_usd)}</span>
          </div>
        </div>
      </div>

      <div className="filters">
        <input
          aria-label="Model filter"
          className="filter-input"
          onChange={(e) => setModelQuery(e.target.value)}
          placeholder="Filter model"
          type="search"
          value={modelQuery}
        />
        <select
          aria-label="Cost sort"
          className="filter-select"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="cost">Highest cost</option>
          <option value="calls">Most calls</option>
          <option value="tokens">Most tokens</option>
          <option value="model">Model</option>
        </select>
        <span className="filter-meta">
          {filteredRows.length} visible / {cost.by_model.length} total
        </span>
      </div>

      {filteredRows.length === 0 ? (
        <EmptyState
          title="No models match the current filters."
          actionLabel="Clear model filters"
          onAction={() => {
            setModelQuery("");
            setSortBy("cost");
          }}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Calls</th>
                <th>Tokens in</th>
                <th>Tokens out</th>
                <th>Share</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.model}>
                  <td>{row.model}</td>
                  <td>{formatNumber(row.calls)}</td>
                  <td>{formatNumber(row.tokens_in)}</td>
                  <td>{formatNumber(row.tokens_out)}</td>
                  <td>
                    {cost.total_cost_usd === 0
                      ? "0%"
                      : `${Math.round((row.cost_usd / cost.total_cost_usd) * 100)}%`}
                  </td>
                  <td>{formatCurrency(row.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
