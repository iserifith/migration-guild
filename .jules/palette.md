## 2024-05-24 - Initial Journal

## 2024-05-24 - Make clickable table rows keyboard accessible
**Learning:** Table rows (`<tr>`) styled as clickable elements with `onClick` handlers must also be keyboard-accessible. Adding a `tabIndex={0}` makes them focusable, and an `onKeyDown` handler listening for "Enter" or "Space" allows keyboard users to interact with them just like mouse users.
**Action:** Always check `onClick` on non-button, non-link elements to ensure they also have equivalent keyboard interaction handlers and `tabIndex` attributes, along with appropriate focus styling (like `:focus-visible`).
