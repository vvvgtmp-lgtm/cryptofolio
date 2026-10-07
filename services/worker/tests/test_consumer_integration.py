import pytest

from tests.conftest import add_tx, create_job, create_portfolio, create_user, get_job, integration
from worker.consumer import JobConsumer
from worker.jobs import HANDLERS, JobOutcome, PermanentJobError

pytestmark = integration


def make_consumer(redis, ctx, handlers=None, **kwargs) -> JobConsumer:
    consumer = JobConsumer(
        redis,
        ctx,
        handlers or HANDLERS,
        stream=ctx.settings.jobs_stream,
        group=ctx.settings.jobs_group,
        consumer="test-consumer",
        block_ms=100,
        **kwargs,
    )
    consumer.ensure_group()
    return consumer


def publish(redis, ctx, job_id):
    redis.xadd(ctx.settings.jobs_stream, {"job_id": job_id})


@pytest.fixture
def user_portfolio(pool):
    user = create_user(pool)
    return user, create_portfolio(pool, user)


def test_processes_an_export_job_end_to_end(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    add_tx(pool, portfolio, "bitcoin", "buy", "1", "40000")
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    consumer = make_consumer(redis, ctx)
    publish(redis, ctx, job.id)
    assert consumer.poll_once() == 1
    row = get_job(pool, job.id)
    assert row["status"] == "done" and row["attempts"] == 1
    assert row["result_key"] == f"{user}/{job.id}.csv"
    assert redis.xpending(ctx.settings.jobs_stream, ctx.settings.jobs_group)["pending"] == 0


def test_permanent_errors_fail_without_retry(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(
        pool, user, "import_csv", {"portfolioId": portfolio, "key": f"{user}/missing.csv"}
    )
    consumer = make_consumer(redis, ctx)
    publish(redis, ctx, job.id)
    consumer.poll_once()
    row = get_job(pool, job.id)
    assert row["status"] == "failed" and "not found" in row["error"]
    assert redis.xlen(ctx.settings.jobs_stream) == 1  # nothing re-queued


def test_crashes_are_retried_then_marked_failed(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})

    def boom(_ctx, _job):
        raise RuntimeError("disk on fire")

    consumer = make_consumer(redis, ctx, {"export_csv": boom}, max_attempts=3)
    publish(redis, ctx, job.id)
    consumer.poll_once()
    assert get_job(pool, job.id)["status"] == "queued"
    consumer.poll_once()
    consumer.poll_once()
    row = get_job(pool, job.id)
    assert row["status"] == "failed" and row["attempts"] == 3
    assert "gave up after 3 attempts" in row["error"]
    assert consumer.poll_once() == 0


def test_reclaims_messages_left_by_a_dead_consumer(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    consumer = make_consumer(redis, ctx, claim_idle_ms=0)
    publish(redis, ctx, job.id)
    # A consumer that reads the message and then "dies" without XACK:
    redis.xreadgroup(
        ctx.settings.jobs_group, "dead-consumer", {ctx.settings.jobs_stream: ">"}, count=1
    )
    consumer.poll_once()
    assert get_job(pool, job.id)["status"] == "done"


def test_skips_jobs_that_are_already_finished(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio}, status="done")
    calls = []

    def handler(_ctx, j):
        calls.append(j.id)
        return JobOutcome()

    consumer = make_consumer(redis, ctx, {"export_csv": handler})
    publish(redis, ctx, job.id)
    consumer.poll_once()
    assert calls == []


def test_garbage_messages_are_acknowledged(redis, ctx):
    consumer = make_consumer(redis, ctx)
    redis.xadd(ctx.settings.jobs_stream, {"job_id": "not-a-uuid"})
    redis.xadd(ctx.settings.jobs_stream, {"something": "else"})
    consumer.poll_once()
    assert redis.xpending(ctx.settings.jobs_stream, ctx.settings.jobs_group)["pending"] == 0


def test_unknown_job_type_fails_permanently(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    consumer = make_consumer(redis, ctx, {"something_else": lambda c, j: JobOutcome()})
    publish(redis, ctx, job.id)
    consumer.poll_once()
    assert get_job(pool, job.id)["status"] == "failed"


def test_permanent_error_class_is_exported():
    assert issubclass(PermanentJobError, Exception)
