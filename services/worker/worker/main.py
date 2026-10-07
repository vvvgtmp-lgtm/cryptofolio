import logging
import signal
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime

from apscheduler.schedulers.background import BackgroundScheduler
from redis import Redis

from .config import Settings
from .consumer import JobConsumer
from .db import make_pool
from .health import HealthServer
from .jobs import HANDLERS, Ctx
from .logging_setup import setup_logging
from .metrics import SCHEDULED_FAILURES
from .prices import PriceClient
from .scheduled import check_alerts, take_snapshots
from .storage import Storage

log = logging.getLogger("worker")
LIVENESS_WINDOW_SECONDS = 300


def run_safely(fn: Callable[[Ctx], int], ctx: Ctx) -> Callable[[], None]:
    def wrapper() -> None:
        started = time.perf_counter()
        try:
            result = fn(ctx)
            log.info(
                "%s finished",
                fn.__name__,
                extra={
                    "task": fn.__name__,
                    "result": result,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )
        except Exception:
            SCHEDULED_FAILURES.labels(fn.__name__).inc()
            log.exception("%s failed", fn.__name__, extra={"task": fn.__name__})

    return wrapper


def check(fn: Callable[[], object]) -> str:
    try:
        fn()
        return "ok"
    except Exception:
        return "error"


def main() -> None:
    settings = Settings()
    setup_logging(settings.log_level)
    pool = make_pool(settings.database_url)
    redis = Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=10)
    ctx = Ctx(
        pool=pool,
        storage=Storage(settings),
        prices=PriceClient(settings.price_service_url),
        settings=settings,
    )
    consumer = JobConsumer(
        redis,
        ctx,
        HANDLERS,
        stream=settings.jobs_stream,
        group=settings.jobs_group,
        consumer=settings.worker_name,
        max_attempts=settings.max_attempts,
    )

    stop = threading.Event()

    def on_signal(signum, _frame):
        log.info("received signal %s, shutting down", signum)
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    def ping_db() -> None:
        with pool.connection(timeout=2) as conn:
            conn.execute("SELECT 1")

    health = HealthServer(
        settings.health_port,
        liveness=lambda: time.monotonic() - consumer.last_heartbeat < LIVENESS_WINDOW_SECONDS,
        readiness=lambda: {
            "postgres": check(ping_db),
            "redis": check(redis.ping),
            "storage": check(ctx.storage.ping),
        },
    )
    health.start()

    scheduler = BackgroundScheduler(timezone="UTC")
    now = datetime.now(UTC)
    scheduler.add_job(
        run_safely(check_alerts, ctx),
        "interval",
        id="check_alerts",
        seconds=settings.alert_check_interval_seconds,
        next_run_time=now,
        max_instances=1,
        coalesce=True,
    )
    scheduler.add_job(
        run_safely(take_snapshots, ctx),
        "cron",
        id="take_snapshots",
        minute=0,
        next_run_time=now,
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    log.info("worker started", extra={"task": settings.worker_name})

    try:
        consumer.run(stop)
    finally:
        scheduler.shutdown(wait=False)
        health.stop()
        pool.close()
        redis.close()
        log.info("worker stopped")


if __name__ == "__main__":
    main()
