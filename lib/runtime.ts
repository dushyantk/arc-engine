// Thin server-side proxy to the FastAPI agent runtime (server/routes/runs.py).
// The browser never needs to know AGENT_RUNTIME_URL directly - it calls
// Next.js API routes under /api/runs/*, which forward here. Keeps the
// runtime's address a server-side implementation detail, same as every
// other backend this app talks to (Postgres, ClickHouse, MinIO).
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:8091";

// Shared secret for the agent runtime. Read here and never sent to the browser:
// every call goes through server-side code, so the token stays on the server.
// Unset is valid for local development, where the runtime is open and says so.
const AGENT_RUNTIME_TOKEN = process.env.AGENT_RUNTIME_TOKEN;

export async function callRuntime(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${AGENT_RUNTIME_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(AGENT_RUNTIME_TOKEN ? { "X-Dailies-Token": AGENT_RUNTIME_TOKEN } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
