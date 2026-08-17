"""Object storage for reference frames, generated video, and VFX package
exports. See ARCHITECTURE.md section 4 for the key layout:
refs/{show}/{asset}.png, gen/{shot}/{version}.mp4, exports/{show}/{sequence}/{shot}/...
"""

import io
import os

from minio import Minio


def get_client() -> Minio:
    endpoint = os.environ.get("MINIO_ENDPOINT", "localhost:9010")
    return Minio(
        endpoint,
        access_key=os.environ["MINIO_ACCESS_KEY"],
        secret_key=os.environ["MINIO_SECRET_KEY"],
        secure=os.environ.get("MINIO_SECURE", "false").lower() == "true",
    )


def ensure_bucket(client: Minio, bucket: str) -> None:
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def put_bytes(client: Minio, bucket: str, key: str, data: bytes, content_type: str) -> str:
    ensure_bucket(client, bucket)
    client.put_object(bucket, key, io.BytesIO(data), length=len(data), content_type=content_type)
    return key


def get_bytes(client: Minio, bucket: str, key: str) -> bytes:
    response = client.get_object(bucket, key)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()
