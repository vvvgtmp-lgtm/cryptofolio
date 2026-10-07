from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def make_pool(url: str) -> ConnectionPool:
    """Small pool; rows come back as dicts."""
    return ConnectionPool(url, min_size=1, max_size=5, kwargs={"row_factory": dict_row}, open=True)
