"""Reference asset ingestion: upload a character/prop/environment/palette
image to MinIO and lock it as an approved reference in Postgres. Not
agentic — this is a deterministic upload-and-record step, called before the
planner needs anything to point a shot brief at.
"""

import os
from uuid import UUID

from minio import Minio

from db.models import ReferenceAsset, ReferenceAssetType
from db.postgres import Database
from storage.minio_client import get_client, put_bytes


def _key(show_id: UUID, name: str) -> str:
    slug = name.lower().replace(" ", "-")
    return f"refs/{show_id}/{slug}.png"


async def ingest_reference_asset(
    db: Database,
    *,
    show_id: UUID,
    asset_type: ReferenceAssetType,
    name: str,
    image_bytes: bytes,
    approved_by: str = "agent",
    minio: Minio | None = None,
) -> ReferenceAsset:
    client = minio or get_client()
    bucket = os.environ.get("MINIO_BUCKET", "dailies")
    key = _key(show_id, name)
    put_bytes(client, bucket, key, image_bytes, content_type="image/png")

    return await db.insert_reference_asset(
        show_id=show_id,
        type=asset_type,
        name=name,
        image_url=key,
        approved_by=approved_by,
    )
