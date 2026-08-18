import { Client } from "minio";

let client: Client | null = null;

export function getMinioClient() {
  if (client) return client;
  const endpoint = process.env.MINIO_ENDPOINT ?? "localhost:9010";
  const [host, port] = endpoint.split(":");
  client = new Client({
    endPoint: host,
    port: port ? Number(port) : undefined,
    useSSL: process.env.MINIO_SECURE === "true",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "",
    secretKey: process.env.MINIO_SECRET_KEY ?? "",
  });
  return client;
}

export const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "dailies";

export async function getObjectBytes(key: string): Promise<Buffer> {
  const stream = await getMinioClient().getObject(MINIO_BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
