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

## 2024-08-20 - Adding Loading Feedback to Async Buttons
**Learning:** Adding `aria-busy` along with dynamic text and disabling a button during async operations provides significantly better screen reader accessibility and visual feedback.
**Action:** Always include loading states for any global async refresh buttons to indicate work is happening in the background.

## 2024-08-21 - Add aria-expanded to clickable table rows
**Learning:** Table rows styled as clickable elements (`role="button"`) that toggle a details panel or log viewer below the list should use `aria-expanded` to communicate their state to screen reader users. This clarifies that interacting with the row expands or collapses additional content.
**Action:** When a custom element like a table row acts as a button to reveal more details, always include `aria-expanded={isExpanded}` along with `role="button"`, `tabIndex`, and keyboard handlers.
## 2026-08-22 - Inline loading states for async actions
**Learning:** During latency on form actions, users lose context if buttons just do nothing. Using a combination of `aria-busy`, disabling controls, and changing button text to "[Action]ing..." provides immediate inline feedback that their interaction was recognized, specifically for the approvals panel in migration-guild.
**Action:** Always implement disabled and `aria-busy` states when submitting asynchronous forms or calling endpoints, updating the button text to show activity, and disabling form fields to prevent double submission.
## 2024-05-24 - Missing keyboard collapse interactions and form focus styles
**Learning:** Expanding UI panels like Artifact Details and Run Logs often lack intuitive keyboard dismissal mechanisms like the `Escape` key, despite having expanded states (`aria-expanded`). Additionally, standard browser focus rings on complex custom form elements (like filter selects) can sometimes suffer from low contrast.
**Action:** When implementing expandable panels or modal-like detail views, always add `Escape` key listeners to allow keyboard users to easily dismiss the view. For form controls, explicitly ensure focus states (`:focus-visible`) match the high-contrast accent colors of the design system.

## 2026-08-30 - Add loading spinners to async buttons
**Learning:** Loading states for async operations in React can benefit from explicit visual spinners rather than just changing text, to clearly indicate that a process is running without feeling stuck, and should use standard ARIA `aria-busy` along with matching visual context.
**Action:** When creating or updating components with async state, include inline loading spinners using common `.spinner` and `.button-content` CSS utilities instead of just swapping label text.
