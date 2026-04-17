import type { ReactNode } from "react";

function StateCard({
  title,
  detail,
  actions,
  compact = false,
  tone = "default",
}: {
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  tone?: "default" | "error";
}) {
  return (
    <div className={`state-card ${compact ? "compact" : ""} ${tone}`}>
      <div className="state-title">{title}</div>
      {detail ? <div className="state-detail">{detail}</div> : null}
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  );
}

export function LoadingState({
  resource,
  compact = false,
}: {
  resource: string;
  compact?: boolean;
}) {
  return <StateCard compact={compact} title={`Loading ${resource}...`} />;
}

export function EmptyState({
  title,
  detail,
  compact = false,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: ReactNode;
  compact?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <StateCard
      compact={compact}
      title={title}
      detail={detail}
      actions={
        actionLabel && onAction ? (
          <button className="state-button" onClick={onAction} type="button">
            {actionLabel}
          </button>
        ) : undefined
      }
    />
  );
}

export function ErrorState({
  resource,
  error,
  onRetry,
  compact = false,
}: {
  resource: string;
  error: Error;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <StateCard
      compact={compact}
      tone="error"
      title={`Couldn't load ${resource}.`}
      detail={error.message}
      actions={
        <button className="state-button" onClick={onRetry} type="button">
          Retry {resource}
        </button>
      }
    />
  );
}
