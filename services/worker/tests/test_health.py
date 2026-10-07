import urllib.error
import urllib.request

import pytest

from worker.health import HealthServer


@pytest.fixture
def server():
    state = {"alive": True, "ready": {"postgres": "ok", "redis": "ok"}}
    srv = HealthServer(0, liveness=lambda: state["alive"], readiness=lambda: state["ready"])
    srv.start()
    yield srv, state
    srv.stop()


def get(srv, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{srv.port}{path}", timeout=2) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_healthz_follows_liveness(server):
    srv, state = server
    assert get(srv, "/healthz")[0] == 200
    state["alive"] = False
    assert get(srv, "/healthz")[0] == 503


def test_readyz_reports_checks(server):
    srv, state = server
    assert get(srv, "/readyz") == (
        200,
        '{"status": "ready", "checks": {"postgres": "ok", "redis": "ok"}}',
    )
    state["ready"] = {"postgres": "error", "redis": "ok"}
    assert get(srv, "/readyz")[0] == 503


def test_metrics_and_404(server):
    srv, _ = server
    status, body = get(srv, "/metrics")
    assert status == 200 and "worker_jobs_total" in body
    assert get(srv, "/nope")[0] == 404
