import boto3
from botocore.config import Config as BotoConfig

from .config import Settings


class Storage:
    """S3-compatible object storage (MinIO locally, GCS interoperability later)."""

    def __init__(self, settings: Settings):
        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=BotoConfig(
                s3={"addressing_style": "path"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )
        self.imports_bucket = settings.s3_bucket_imports
        self.exports_bucket = settings.s3_bucket_exports

    def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None:
        self._s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, bucket: str, key: str) -> bytes:
        return self._s3.get_object(Bucket=bucket, Key=key)["Body"].read()

    def ping(self) -> None:
        self._s3.head_bucket(Bucket=self.exports_bucket)
