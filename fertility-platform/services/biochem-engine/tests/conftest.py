from datetime import date, timedelta

import pytest

START = date(2025, 3, 1)


def D(n: int) -> date:
    """Cycle day n (1-based) as a calendar date."""
    return START + timedelta(days=n - 1)


@pytest.fixture
def day():
    return D
