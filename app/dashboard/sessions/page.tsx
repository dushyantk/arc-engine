import Link from "next/link";
import { getRecentSessions } from "@/lib/data";

export const dynamic = "force-dynamic";

function formatTime(iso: string) {
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  return new Date(normalized).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function SessionsPage() {
  const sessions = await getRecentSessions();

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Session log
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Every real agent run against this stack, planner through approval
        gate. Cost and latency come straight from{" "}
        <code className="font-mono">agent_decision_log</code>.
      </p>

      <div className="mt-8 flex flex-col gap-2">
        {sessions.map((session) => (
          <Link
            key={session.runId}
            href={`/dashboard/sessions/${session.runId}`}
            className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-ring"
          >
            <div>
              <p className="font-mono text-xs text-foreground">
                {session.runId}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatTime(session.startedAt)}
                {session.hasGeneration ? " · real Veo generation" : ""}
              </p>
            </div>
            <div className="text-right font-mono text-xs text-muted-foreground">
              <p>{session.eventCount} calls</p>
              <p>${session.totalCost.toFixed(4)}</p>
            </div>
          </Link>
        ))}
        {sessions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No agent runs logged yet.
          </p>
        ) : null}
      </div>
    </div>
  );
}
