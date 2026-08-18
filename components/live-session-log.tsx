"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Circle, Eye, Film, Pencil, RefreshCw } from "lucide-react";
import type { DecisionLogEvent } from "@/lib/data";

const STAGE_CONFIG: Record<
  DecisionLogEvent["agentName"],
  { label: string; icon: typeof Pencil }
> = {
  planner: { label: "Plan", icon: Pencil },
  generation_adapter: { label: "Generate", icon: Film },
  critic: { label: "Critique", icon: Eye },
  revision_agent: { label: "Revise", icon: RefreshCw },
  approval_gate: { label: "Approve", icon: Check },
};

function formatTime(iso: string) {
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  return new Date(normalized).toLocaleTimeString("en-US", { hour12: false });
}

function eventIdentity(event: DecisionLogEvent) {
  return `${event.runId}-${event.createdAt}-${event.step}`;
}

export function LiveSessionLog({
  runId,
  initialEvents,
}: {
  runId: string;
  initialEvents: DecisionLogEvent[];
}) {
  const [events, setEvents] = useState(initialEvents);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set(initialEvents.map(eventIdentity)));

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${runId}/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event: DecisionLogEvent = JSON.parse(message.data);
      const identity = eventIdentity(event);
      if (seen.current.has(identity)) return;
      seen.current.add(identity);
      setEvents((prev) => [...prev, event]);
    };
    return () => source.close();
  }, [runId]);

  const totalCost = events.reduce((sum, e) => sum + e.costUsd, 0);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${connected ? "animate-pulse bg-success" : "bg-muted-foreground/40"}`}
          />
          {connected ? "LIVE" : "CONNECTING"}
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {events.length} calls &middot; ${totalCost.toFixed(4)}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {events.map((event, i) => {
          const stage = STAGE_CONFIG[event.agentName];
          const Icon = stage?.icon ?? Circle;
          return (
            <div
              key={`${eventIdentity(event)}-${i}`}
              className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold tracking-wide uppercase">
                    {stage?.label ?? event.agentName}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {event.step}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {event.outputRef || event.inputRef}
                </p>
              </div>
              <div className="shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                <p>{formatTime(event.createdAt)}</p>
                <p>
                  {event.latencyMs}ms &middot; ${event.costUsd.toFixed(4)}
                </p>
              </div>
            </div>
          );
        })}
        {events.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            Waiting for the first agent call&hellip;
          </p>
        ) : null}
      </div>
    </div>
  );
}
