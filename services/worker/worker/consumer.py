"""Redis Streams consumer-group loop.

    api --XADD job_id--> stream "jobs" --XREADGROUP--> worker(s) --XACK

Run several worker containers: the consumer group spreads messages across them.
A message read by a worker that died is reclaimed with XAUTOCLAIM after it has
been idle for `claim_idle_ms`.
"""

import logging
import threading
import time
import uuid
from collections.abc import Callable

from psycopg.types.json import Jsonb
from redis import Redis
from redis.exceptions import ResponseError

from .jobs import Ctx, Job, JobOutcome, PermanentJobError
from .metrics import JOB_DURATION, JOBS

log = logging.getLogger("worker.consumer")


class JobConsumer:
    def __init__(
        self,
        redis: Redis,
        ctx: Ctx,
        handlers: dict[str, Callable[[Ctx, Job], JobOutcome]],
        *,
        stream: str,
        group: str,
        consumer: str,
        max_attempts: int = 3,
        block_ms: int = 5000,
        claim_idle_ms: int = 60_000,
    ):
        self._redis = redis
        self._ctx = ctx
        self._handlers = handlers
        self._stream = stream
        self._group = group
        self._consumer = consumer
        self._max_attempts = max_attempts
        self._block_ms = block_ms
        self._claim_idle_ms = claim_idle_ms
        self.last_heartbeat = time.monotonic()

    def ensure_group(self) -> None:
        try:
            self._redis.xgroup_create(self._stream, self._group, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def run(self, stop: threading.Event) -> None:
        self.ensure_group()
        log.info("consuming", extra={"task": f"{self._stream}/{self._group}/{self._consumer}"})
        while not stop.is_set():
            try:
                self.poll_once()
            except Exception:
                log.exception("consumer loop error; backing off")
                stop.wait(2)

    def poll_once(self) -> int:
        self.last_heartbeat = time.monotonic()
        handled = self._reclaim()
        response = self._redis.xreadgroup(
            self._group, self._consumer, {self._stream: ">"}, count=10, block=self._block_ms
        )
        for _stream, messages in response or []:
            for message_id, fields in messages:
                self._handle(message_id, fields)
                handled += 1
        return handled

    def _reclaim(self) -> int:
        _next_id, messages, *_ = self._redis.xautoclaim(
            self._stream,
            self._group,
            self._consumer,
            min_idle_time=self._claim_idle_ms,
            start_id="0-0",
            count=10,
        )
        for message_id, fields in messages:
            log.warning("reclaimed stale message", extra={"message_id": message_id})
            self._handle(message_id, fields or {})
        return len(messages)

    def _handle(self, message_id: str, fields: dict) -> None:
        try:
            self._process(fields.get("job_id"))
        finally:
            self._redis.xack(self._stream, self._group, message_id)

    def _process(self, job_id: str | None) -> None:
        job = self._start(job_id)
        if job is None:
            return
        extra = {"job_id": job.id, "job_type": job.type, "attempts": job.attempts}
        started = time.perf_counter()
        try:
            handler = self._handlers.get(job.type)
            if handler is None:
                raise PermanentJobError(f"unknown job type: {job.type}")
            outcome = handler(self._ctx, job)
        except PermanentJobError as exc:
            log.warning("job failed permanently: %s", exc, extra=extra)
            self._finish(job, "failed", error=str(exc))
            JOBS.labels(job.type, "failed").inc()
        except Exception as exc:
            if job.attempts >= self._max_attempts:
                log.exception("job failed, giving up", extra=extra)
                self._finish(job, "failed", error=f"gave up after {job.attempts} attempts: {exc}")
                JOBS.labels(job.type, "failed").inc()
            else:
                log.exception("job failed, will retry", extra=extra)
                self._requeue(job)
                JOBS.labels(job.type, "retried").inc()
        else:
            log.info("job done", extra=extra)
            self._finish(job, "done", outcome=outcome)
            JOBS.labels(job.type, "done").inc()
        finally:
            JOB_DURATION.labels(job.type).observe(time.perf_counter() - started)

    def _start(self, job_id: str | None) -> Job | None:
        try:
            uuid.UUID(str(job_id))
        except ValueError:
            log.warning("ignoring message without a valid job_id", extra={"job_id": job_id})
            return None
        with self._ctx.pool.connection() as conn:
            row = conn.execute(
                "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now() "
                "WHERE id = %s AND status IN ('queued', 'running') "
                "RETURNING id, user_id, type, params, attempts",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        return Job(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            type=row["type"],
            params=row["params"],
            attempts=row["attempts"],
        )

    def _finish(
        self, job: Job, status: str, outcome: JobOutcome | None = None, error: str | None = None
    ):
        outcome = outcome or JobOutcome()
        with self._ctx.pool.connection() as conn:
            conn.execute(
                "UPDATE jobs SET status = %s, result_key = %s, result = %s, error = %s, "
                "updated_at = now() WHERE id = %s",
                (
                    status,
                    outcome.result_key,
                    Jsonb(outcome.result) if outcome.result is not None else None,
                    error[:1000] if error else None,
                    job.id,
                ),
            )

    def _requeue(self, job: Job) -> None:
        with self._ctx.pool.connection() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'queued', updated_at = now() WHERE id = %s", (job.id,)
            )
        self._redis.xadd(self._stream, {"job_id": job.id}, maxlen=10_000, approximate=True)
