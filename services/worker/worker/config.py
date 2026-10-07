import socket

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All configuration comes from environment variables (e.g. DATABASE_URL)."""

    database_url: str = "postgres://cryptofolio:cryptofolio@localhost:5432/cryptofolio"
    redis_url: str = "redis://localhost:6379/0"
    price_service_url: str = "http://localhost:8000"
    s3_endpoint: str = "http://localhost:9000"
    s3_region: str = "us-east-1"
    s3_access_key: str = "cryptofolio"
    s3_secret_key: str = "cryptofolio-secret"
    s3_bucket_imports: str = "cf-imports"
    s3_bucket_exports: str = "cf-exports"
    jobs_stream: str = "jobs"
    jobs_group: str = "workers"
    worker_name: str = Field(default_factory=socket.gethostname)
    max_attempts: int = 3
    alert_check_interval_seconds: int = 60
    health_port: int = 9100
    log_level: str = "info"
