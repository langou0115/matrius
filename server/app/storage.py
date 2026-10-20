import logging
import threading

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import get_settings

logger = logging.getLogger(__name__)

_client = None
_bucket_ready = False
_lock = threading.Lock()


def get_s3_client():
    global _client
    if _client is None:
        settings = get_settings()
        _client = boto3.client(
            "s3",
            endpoint_url=settings.rustfs_endpoint,
            aws_access_key_id=settings.rustfs_access_key,
            aws_secret_access_key=settings.rustfs_secret_key,
            region_name=settings.rustfs_region,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )
    return _client


def ensure_bucket() -> None:
    global _bucket_ready
    if _bucket_ready:
        return
    with _lock:
        if _bucket_ready:
            return
        bucket = get_settings().rustfs_bucket
        client = get_s3_client()
        try:
            client.head_bucket(Bucket=bucket)
        except ClientError:
            client.create_bucket(Bucket=bucket)
        _bucket_ready = True


def check_storage() -> None:
    ensure_bucket()


def put_object(key: str, data: bytes, content_type: str) -> None:
    ensure_bucket()
    get_s3_client().put_object(
        Bucket=get_settings().rustfs_bucket,
        Key=key,
        Body=data,
        ContentType=content_type,
        ContentLength=len(data),
    )


def get_object(key: str):
    ensure_bucket()
    return get_s3_client().get_object(Bucket=get_settings().rustfs_bucket, Key=key)


def delete_object(key: str) -> None:
    ensure_bucket()
    try:
        get_s3_client().delete_object(Bucket=get_settings().rustfs_bucket, Key=key)
    except ClientError:
        logger.warning("Unable to delete storage object %s", key, exc_info=True)
