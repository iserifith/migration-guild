from legacy_python_utils import normalize_customer_name


def test_normalizes_customer_name() -> None:
    assert normalize_customer_name("  Anna   SMITH ") == "anna smith"
