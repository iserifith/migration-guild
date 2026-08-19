## 2024-05-24 - Initial Journal

## 2024-05-24 - Make clickable table rows keyboard accessible
**Learning:** Table rows (`<tr>`) styled as clickable elements with `onClick` handlers must also be keyboard-accessible. Adding a `tabIndex={0}` makes them focusable, and an `onKeyDown` handler listening for "Enter" or "Space" allows keyboard users to interact with them just like mouse users.
**Action:** Always check `onClick` on non-button, non-link elements to ensure they also have equivalent keyboard interaction handlers and `tabIndex` attributes, along with appropriate focus styling (like `:focus-visible`).

## 2024-05-25 - Tooltips for disabled action buttons
**Learning:** Adding a title attribute to explain why a button is disabled significantly improves UX. It provides context to the user who might be wondering why a button is not clickable. Similarly, providing tooltips for active but icon-like or ambiguous buttons, like pagination arrows, offers more context for assistive tech and power users.
**Action:** When disabling actionable buttons like pagination arrows, always provide a title or tooltip explaining the condition (e.g., 'First page reached'). When the button is active, explain the action (e.g., 'Next page').
## 2024-05-18 - Centralizing ARIA live regions for async states
**Learning:** The application heavily abstracts async state rendering into `ViewState.tsx` (`LoadingState`, `EmptyState`, `ErrorState`).
**Action:** By adding `role="status"` and `role="alert"` centrally to `StateCard`, we guarantee consistent screen reader announcements for all dynamic state changes across every tab without needing to sprinkle `aria-live` regions everywhere.
