"""Tiny HTTP server so orchestrators can probe a process that has no web API."""

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prometheus_client import CONTENT_TYPE_LATEST, generate_latest


class HealthServer:
    def __init__(
        self,
        port: int,
        liveness: Callable[[], bool],
        readiness: Callable[[], dict[str, str]],
    ):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if self.path == "/healthz":
                    ok = liveness()
                    outer._send(self, 200 if ok else 503, {"status": "ok" if ok else "stalled"})
                elif self.path == "/readyz":
                    checks = readiness()
                    ready = all(v == "ok" for v in checks.values())
                    outer._send(
                        self,
                        200 if ready else 503,
                        {"status": "ready" if ready else "not_ready", "checks": checks},
                    )
                elif self.path == "/metrics":
                    body = generate_latest()
                    self.send_response(200)
                    self.send_header("Content-Type", CONTENT_TYPE_LATEST)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    outer._send(self, 404, {"status": "not_found"})

            def log_message(self, *_args):  # keep probe traffic out of the logs
                pass

        self._server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @staticmethod
    def _send(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
