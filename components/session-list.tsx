"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Play } from "lucide-react";

export type SessionRow = {
  runId: string;
  startedAt: string;
  eventCount: number;
  totalCost: number;
  hasGeneration: boolean;
};

export type RunnableShotRow = {
  shotId: string;
  shotCode: string;
  status: string;
  showId: string;
  showName: string;
  sequenceCode: string;
  versionCount: number;
};

type ActiveRun = { run_id: string; shot_code: string; mode: string } | null;

const POLL_INTERVAL_MS = 3000;

function formatTime(iso: string) {
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  return new Date(normalized).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const MODE_LABEL: Record<string, string> = {
  generate: "generating",
  recritique: "re-critiquing",
  reuse_prompt: "re-running the same prompt on",
};

function LiveDot() {
  return (
    <span className="relative flex size-2" aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70 motion-reduce:animate-none" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  );
}

/**
 * The session log, with the one thing the list could never say before: which of
 * these runs is happening right now.
 *
 * A finished run and a running one are both just rows in agent_decision_log, so
 * liveness cannot be derived from the log itself - it comes from the runtime's
 * own single-flight marker via /api/runs/status, which now carries the run_id.
 * Polled rather than streamed: this is one small JSON read, and the run's actual
 * step-by-step stream already exists on the session detail page.
 */
export function SessionList({
  sessions,
  runnableShots,
  runtimeReachable,
}: {
  sessions: SessionRow[];
  runnableShots: RunnableShotRow[];
  runtimeReachable: boolean;
}) {
  const [active, setActive] = useState<ActiveRun>(null);
  const [reachable, setReachable] = useState(runtimeReachable);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/runs/status", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        if (cancelled) return;
        setActive(body?.active ?? null);
        setReachable(true);
      } catch {
        // The agent runtime being down is a normal state for this product -
        // the dashboard reads its stores directly and stays useful without it.
        if (!cancelled) setReachable(false);
      }
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // A run that has just started may have no logged rows yet, so it can be live
  // without appearing in the list below.
  const activeInList =
    active !== null && sessions.some((session) => session.runId === active.run_id);

  return (
    <>
      {active ? (
        <div className="mt-6 rounded-md border border-primary/40 bg-primary/5 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <LiveDot />
              <span className="font-mono text-[12px] text-foreground">
                Running now — {MODE_LABEL[active.mode] ?? active.mode}{" "}
                {active.shot_code}
              </span>
            </div>
            <Link
              href={`/dashboard/sessions/${active.run_id}`}
              className="font-mono text-[12px] text-primary hover:underline"
            >
              Watch it live →
            </Link>
          </div>
          {!activeInList ? (
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              {active.run_id} — no steps logged yet; it will appear below as the
              agents report in.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 rounded-md border border-border bg-card px-4 py-3">
          <p className="font-mono text-[12px] text-muted-foreground">
            {reachable
              ? "Nothing running. One run at a time — the runtime refuses a second while one is in flight."
              : "Agent runtime unreachable, so nothing can be started from here. The log below still reads from ClickHouse."}
          </p>

          {reachable && runnableShots.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">
                Start one on:
              </span>
              {runnableShots.map((shot) => (
                <Link
                  key={shot.shotId}
                  href={`/dashboard/${shot.showId}/${shot.sequenceCode}/${shot.shotCode}`}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 py-1 font-mono text-[11px] hover:border-ring"
                >
                  <Play className="size-3 text-primary" />
                  {shot.shotCode}
                  <span className="text-muted-foreground">
                    {shot.showName} · v{shot.versionCount}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}

          {reachable && runnableShots.length === 0 ? (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              No shot has a brief yet, and a run plans against one — author a brief on a
              shot page and it becomes startable.
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-8 flex flex-col gap-2">
        {sessions.map((session) => {
          const isLive = active?.run_id === session.runId;
          return (
            <Link
              key={session.runId}
              href={`/dashboard/sessions/${session.runId}`}
              className={`flex items-center justify-between rounded-md border px-4 py-3 transition-colors ${
                isLive
                  ? "border-primary/50 bg-primary/5"
                  : "border-border bg-card hover:border-ring"
              }`}
            >
              <div>
                <p className="flex items-center gap-2 font-mono text-xs text-foreground">
                  {isLive ? <LiveDot /> : null}
                  {session.runId}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isLive ? "running now · " : ""}
                  {formatTime(session.startedAt)}
                  {session.hasGeneration ? " · real Veo generation" : ""}
                </p>
              </div>
              <div className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                <p>{session.eventCount} calls</p>
                <p>${session.totalCost.toFixed(4)}</p>
              </div>
            </Link>
          );
        })}
        {sessions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No agent runs logged yet.
          </p>
        ) : null}
      </div>
    </>
  );
}
