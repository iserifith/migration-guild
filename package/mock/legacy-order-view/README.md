# legacy-order-view

`legacy-order-view` is a legacy **view-bearing** module fixture used to exercise the
`view-regeneration-*` and `view-logic-placement-*` audit rules against a real fixture
rather than only unit-test strings (Spec 008, **US1**).

## What it does

A Struts 1.x `Action` (`OrderViewAction`) serves two request paths for the order screen:

- `/order/view` — validates the order and renders a summary into `order-view.jsp`
- `/order/submit` — runs the **same** validation and the **same** pricing/stock business
  rules, then books the order

Both paths share validation logic and business logic that is currently **inline** in the
view-handling class — exactly the shape the audit rules are built to flag if a migration
leaves it in place (and to reward when a migration extracts it correctly).

## Why this fixture exists

It gives the pipeline a real view module so a kit-level regression (e.g. a prompt change
that stops the audit agent from scanning `.jsp` files, or a stack-pack merge that drops a
signal) is caught by a fixture-driven run, not just synthetic unit-test strings.

## Intentional legacy traits

- Struts 1.x (`org.apache.struts.action.Action`) + servlet 2.4 (`war` packaging)
- JSP with `<%@` directives, scriptlets (`<% … %>`), and `<jsp:useBean>` — trips the
  `jsp-view` classification signal
- `OrderViewAction extends ...Action` and imports `org.apache.struts.action.*` — trips the
  `struts-action` classification signal
- `SimpleDateFormat` in shared state
- Raw `Map`/`List` (no generics)
- Validation and pricing/stock business rules inlined in the handler

## Solvable — not a trap

The logic is separable from the markup: business logic lives in the `.java` `Action`, not
in the JSP. A correct migration produces an API contract with the shared validation
consolidated into one named `*Validator` module and the shared pricing/stock rules into one
named `*Service` module, and contains **no** `<%`, `javax.faces`, or Struts imports — so a
correctly-migrated result yields **zero** `view-regeneration-*` and **zero**
`view-logic-placement-*` findings (SC-004). The deliberately-inlined/bait variant that
exercises the findings lives in the audit rules' own test suite, not as committed fixture
output.
