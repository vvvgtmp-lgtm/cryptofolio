from prometheus_client import Counter, Histogram

REQUESTS = Histogram(
    "http_request_duration_seconds", "HTTP request latency", ["method", "route", "status"]
)
CACHE_EVENTS = Counter("price_cache_events_total", "Price cache lookups by outcome", ["outcome"])
UPSTREAM_ERRORS = Counter(
    "price_upstream_errors_total", "Failed calls to the price provider", ["provider"]
)
