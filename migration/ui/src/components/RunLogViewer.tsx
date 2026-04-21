import { useMemo, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

interface RunLogViewerProps {
  selectedRunId: string | null;
  selectedRunLogFile: string | null;
  log: string | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}

export default function RunLogViewer({
  selectedRunId,
  selectedRunLogFile,
  log,
  loading,
  error,
  onRetry,
}: RunLogViewerProps) {
  const [query, setQuery] = useState("");
  const [wrapLines, setWrapLines] = useState(true);
  const logLines = useMemo(() => {
    if (!log?.trim()) {
      return [] as Array<{ number: number; text: string }>;
    }

    return log.split(/\r?\n/).map((text, index) => ({
      number: index + 1,
      text,
    }));
  }, [log]);

  const filteredLines = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return logLines;
    }
    return logLines.filter((line) => line.text.toLowerCase().includes(needle));
  }, [logLines, query]);

  if (selectedRunId == null) {
    return <EmptyState compact title="Select a run to view its log." />;
  }

  if (loading) {
    return <LoadingState compact resource="run log" />;
  }

  if (error) {
    return <ErrorState compact resource="run log" error={error} onRetry={onRetry} />;
  }

  if (!log?.trim()) {
    return <EmptyState compact title="No log output captured for this run." />;
  }

  return (
    <div className="log-shell">
      <div className="log-toolbar">
        <span className="filter-meta">Selected run: {selectedRunId}</span>
        {selectedRunLogFile ? (
          <span className="filter-meta">Source: {selectedRunLogFile}</span>
        ) : null}
        <span className="filter-meta">
          {filteredLines.length} of {logLines.length} lines
        </span>
        <button className="state-button" onClick={onRetry} type="button">
          Reload log
        </button>
      </div>
      <div className="log-toolbar">
        <input
          aria-label="Run log filter"
          className="filter-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter log lines"
          type="search"
        />
        <button
          className="state-button"
          onClick={() => setWrapLines((current) => !current)}
          type="button"
        >
          {wrapLines ? "Disable wrap" : "Enable wrap"}
        </button>
      </div>
      {filteredLines.length === 0 ? (
        <EmptyState compact title="No log lines match this filter." />
      ) : (
        <pre className={`log-output ${wrapLines ? "" : "no-wrap"}`.trim()}>
          {filteredLines.map((line) => (
            <div key={line.number} className="log-line">
              <span className="log-line-number">{line.number}</span>
              <span className="log-line-text">{line.text || " "}</span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
