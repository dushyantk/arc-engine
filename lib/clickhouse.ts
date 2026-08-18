import { createClient } from "@clickhouse/client";

let client: ReturnType<typeof createClient> | null = null;

export function getClickHouseClient() {
  if (client) return client;
  client = createClient({
    host: `http${process.env.CLICKHOUSE_SECURE === "true" ? "s" : ""}://${process.env.CLICKHOUSE_HOST ?? "localhost"}:${process.env.CLICKHOUSE_PORT ?? "8124"}`,
    username: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    database: process.env.CLICKHOUSE_DATABASE ?? "dailies",
  });
  return client;
}
