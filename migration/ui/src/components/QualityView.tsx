import { useMemo, useState } from "react";
import type { EvaluationSummary } from "../types";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

export default function QualityView({
  evaluations,
  loading,
  error,
  onRetry,
}: {
  evaluations: EvaluationSummary[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const [resultFilter, setResultFilter] = useState("all");
  const [sortBy, setSortBy] = useState("score");

  const filteredEvaluations = useMemo(() => {
    const next = evaluations.filter((evaluation) => {
      if (resultFilter === "failed-only") {
        return evaluation.failed > 0;
      }

      if (resultFilter === "passing-only") {
        return evaluation.failed === 0;
      }

      return true;
    });

    next.sort((left, right) => {
      if (sortBy === "failures") {
        return right.failed - left.failed;
      }

      if (sortBy === "name") {
        return left.evaluator.localeCompare(right.evaluator);
      }

      return (right.avg_score ?? -1) - (left.avg_score ?? -1);
    });

    return next;
  }, [evaluations, resultFilter, sortBy]);

  if (loading) {
    return <LoadingState resource="evaluations" />;
  }

  if (error) {
    return <ErrorState resource="evaluations" error={error} onRetry={onRetry} />;
  }

  if (evaluations.length === 0) {
    return (
      <EmptyState
        title="No evaluation summary available."
        actionLabel="Reload evaluations"
        onAction={onRetry}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="filters">
        <select
          aria-label="Evaluation result filter"
          className="filter-select"
          value={resultFilter}
          onChange={(e) => setResultFilter(e.target.value)}
        >
          <option value="all">All evaluators</option>
          <option value="failed-only">Failures only</option>
          <option value="passing-only">Passing only</option>
        </select>
        <select
          aria-label="Evaluation sort"
          className="filter-select"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="score">Highest score</option>
          <option value="failures">Most failures</option>
          <option value="name">Evaluator</option>
        </select>
        <span className="filter-meta">
          {filteredEvaluations.length} visible / {evaluations.length} total
        </span>
      </div>

      {filteredEvaluations.length === 0 ? (
        <EmptyState
          title="No evaluations match the current filters."
          actionLabel="Clear evaluation filters"
          onAction={() => {
            setResultFilter("all");
            setSortBy("score");
          }}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Evaluator</th>
                <th>Total</th>
                <th>Passed</th>
                <th>Failed</th>
                <th>Pass rate</th>
                <th>Avg score</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvaluations.map((evaluation) => (
                <tr key={evaluation.evaluator}>
                  <td>{evaluation.evaluator}</td>
                  <td>{evaluation.total}</td>
                  <td>{evaluation.passed}</td>
                  <td>{evaluation.failed}</td>
                  <td>
                    {evaluation.total === 0
                      ? "-"
                      : `${Math.round((evaluation.passed / evaluation.total) * 100)}%`}
                  </td>
                  <td>
                    {evaluation.avg_score != null ? evaluation.avg_score.toFixed(2) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
