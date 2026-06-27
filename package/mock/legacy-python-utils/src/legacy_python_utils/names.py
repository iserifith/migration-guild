"""Legacy customer-name normalization."""


def normalize_customer_name(value: str) -> str:
    return " ".join(value.strip().lower().split())
