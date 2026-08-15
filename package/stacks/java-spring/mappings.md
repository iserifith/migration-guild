# Common Legacy-to-Spring-Boot Mappings

- JAX-RS resources become Spring MVC REST controllers; exception mappers become controller advice.
- Servlets become controllers; servlet filters become `OncePerRequestFilter` or interceptors.
- EJB service beans become Spring services/components with constructor injection.
- Struts actions become controllers, request DTOs, validation, and services.
- XML bean wiring becomes configuration classes, beans, or component scanning.
- JUnit 4 tests become JUnit 5 tests; prefer narrow MVC or unit tests over full-context tests.

## View modules → API contracts (NEVER UI components)

This is a hard rule, declared by `view_contract` in `stack.yaml` and enforced by the
`view-regeneration-*` audit rules. A legacy view-handling module (Struts action bound to a
view, servlet page renderer, JSP-backed controller, JSF/Facelets backing bean, etc.) maps
to a structured API contract plus behavior-preserving handlers — **never** to regenerated
view-layer UI.

1. **View-bound handlers become contract-backed endpoints.** Struts actions, servlet page
   renderers, and JSP/JSF-backed controllers map to Spring MVC endpoints whose routing,
   parameter binding, validation, and business logic are preserved as behavior. The
   migrated module exposes its surface as the pack-declared contract (`view_contract.format`,
   default `openapi`, with `alternates: [mcp-tools]` permitted).
2. **Layout, markup, and styling are dropped, not ported.** Template structure, CSS,
   JavaScript includes, custom tag usage, and presentation helpers are discarded. They are
   not regenerated as `.jsp`/`.xhtml` files, ported layouts, or copy-forwarded assets.
3. **Purely-presentational views are recorded as intentionally dropped.** A view with no
   scriptlet/EL logic and no bound backing bean — only layout — is recorded with
   `status: skipped` plus the `view-dropped-presentational` meaningful tag and an artifact
   event carrying the stated reason. It is **never** regenerated as UI.
4. **Low-confidence presentation/behavior separation fails closed to review.** When the
   agent cannot confidently separate behavior from presentation, the artifact is marked
   `blocked` with the `blocked-human-decision` tag rather than regenerated as UI. This
   keeps the "discard layout" rule from accidentally discarding business logic.
5. **Placement of extracted logic.** Declared by `logic_extraction` in `stack.yaml` and
   enforced by the `view-logic-placement-*` audit rules — this narrows point 1 above from
   "preserved as behavior" to "preserved in a dedicated module":
   - Validation logic extracted from a migrated view-handling module consolidates into a
     dedicated, named `*Validator` module; business logic into a dedicated, named `*Service`
     module.
   - The contract-backed endpoint/handler only binds and delegates — routing, parameter
     binding, invoking the service/validator, and response shaping. Non-trivial validation
     or business-rule logic MUST NOT appear inline in the handler.
   - A rule shared across multiple endpoints lives in one shared module used by all of
     them — never copied per-endpoint.
   - Logic used by exactly one endpoint still gets its own named module (isolation for
     testing, not only deduplication).
   - A trivial pass-through view carrying no validation/business rules beyond delegation
     needs no empty `*Service`/`*Validator` shell and may delegate directly to an existing
     domain service.

When this section is in tension with anything above, this section wins for view-handling
modules: contracts in, UI out.
