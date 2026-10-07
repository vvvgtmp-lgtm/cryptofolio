from prometheus_client import Counter, Histogram

JOBS = Counter("worker_jobs_total", "Jobs processed", ["type", "outcome"])
JOB_DURATION = Histogram("worker_job_duration_seconds", "Job processing time", ["type"])
ALERTS_TRIGGERED = Counter("worker_alerts_triggered_total", "Price alerts triggered")
SNAPSHOTS_WRITTEN = Counter("worker_snapshots_written_total", "Portfolio snapshots upserted")
SCHEDULED_FAILURES = Counter(
    "worker_scheduled_task_failures_total", "Scheduled task failures", ["task"]
)
