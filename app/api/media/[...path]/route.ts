import { NextRequest } from "next/server";
import { getMinioClient, MINIO_BUCKET } from "@/lib/minio";

// Streams a generated video or reference image straight out of MinIO.
// Supports Range requests since <video> elements need them to seek.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const key = path.join("/");
  const client = getMinioClient();

  let size: number;
  try {
    const stat = await client.statObject(MINIO_BUCKET, key);
    size = stat.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const contentType = key.endsWith(".mp4")
    ? "video/mp4"
    : key.endsWith(".png")
      ? "image/png"
      : "application/octet-stream";

  const range = request.headers.get("range");
  if (range) {
    const match = /bytes=(\d+)-(\d+)?/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : size - 1;
    const length = end - start + 1;

    const stream = await client.getPartialObject(MINIO_BUCKET, key, start, length);
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(length),
      },
    });
  }

  const stream = await client.getObject(MINIO_BUCKET, key);
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
    },
  });
}
