import { getRecentSessions, getRunnableShots } from "@/lib/data";
import { callRuntime } from "@/lib/runtime";
import { SessionList } from "@/components/session-list";

export const dynamic = "force-dynamic";

// Asked once server-side so the page's first paint already knows whether the
// runtime is up; the client then polls for liveness. Without this the list
// would flash "unreachable" on every load while the first poll is in flight.
async function runtimeIsReachable() {
  try {
    const { status } = await callRuntime("/runs/status");
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

export default async function SessionsPage() {
  const [sessions, runnableShots, runtimeReachable] = await Promise.all([
    getRecentSessions(),
    getRunnableShots(),
    runtimeIsReachable(),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Session log
      </h1>
      <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
        Every real agent run against this stack, planner through approval gate. Cost and
        latency come straight from{" "}
        <code className="font-mono">agent_decision_log</code>. Whether a run is still
        going is a separate question the log cannot answer on its own — that comes from
        the runtime.
      </p>

      <SessionList
        sessions={sessions}
        runnableShots={runnableShots}
        runtimeReachable={runtimeReachable}
      />
    </div>
  );
}
