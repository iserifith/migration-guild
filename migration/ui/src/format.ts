import type { TimeDisplayMode } from "./types";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTimestamp(
  value: string | null,
  mode: TimeDisplayMode = "utc",
): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  if (mode === "local") {
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())} Local`;
  }

  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`;
}

export function formatAgeMinutes(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "-";
  }

  if (value < 60) {
    return `${value}m`;
  }

  const hours = Math.floor(value / 60);
  const minutes = value % 60;

  if (hours < 24) {
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (remainingHours === 0) {
    return `${days}d`;
  }

  return `${days}d ${remainingHours}h`;
}

export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) {
    return "Running";
  }

  const start = new Date(startedAt);
  const end = new Date(finishedAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "-";
  }

  const totalMinutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  return formatAgeMinutes(totalMinutes);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCurrency(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return value.replace(/[_-]+/g, " ");
}
