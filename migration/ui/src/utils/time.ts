/**
 * Shared time-formatting helpers for UI components.
 */

/**
 * Renders an ISO timestamp as a short relative-age string such as `12s`, `4m`, `3h`.
 *
 * Clamped at zero so future-dated timestamps (clock skew, fresh rows) don't render
 * negative values.
 */
export function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}
