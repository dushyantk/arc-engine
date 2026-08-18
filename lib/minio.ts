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
