// Thin server-side proxy to the FastAPI agent runtime (server/routes/runs.py).
// The browser never needs to know AGENT_RUNTIME_URL directly - it calls
// Next.js API routes under /api/runs/*, which forward here. Keeps the
// runtime's address a server-side implementation detail, same as every
// other backend this app talks to (Postgres, ClickHouse, MinIO).
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:8091";

export async function callRuntime(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${AGENT_RUNTIME_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
