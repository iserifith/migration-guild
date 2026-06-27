# Test convention

Use pytest and write characterization tests before changing legacy behavior. Keep tests under `tests/`, name files `test_*.py`, and prefer small fixtures with explicit scope. Test public behavior rather than implementation details; use parametrization for input matrices and isolate filesystem, clock, environment, network, and database boundaries. Add framework test clients only where plain unit tests cannot cover the contract.
