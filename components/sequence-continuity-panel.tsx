"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SequenceStatusBadge } from "@/components/status-badge";

export function SequenceContinuityPanel({
  sequenceId,
  status,
  notes,
  checkedAt,
  allShotsApproved,
}: {
  sequenceId: string;
  status: "pending" | "approved" | "needs_human";
  notes: string | null;
  checkedAt: string | null;
  allShotsApproved: boolean;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runContinuityPass() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/runs/sequence-continuity", {
        method: "POST",
        body: JSON.stringify({ sequence_id: sequenceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ?? "Continuity pass failed.");
        setRunning(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the agent runtime.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Cross-shot continuity
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            A sequence is approved only when every shot is approved and this
            final pass agrees they belong together.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SequenceStatusBadge status={status} />
          <Button
            size="sm"
            variant="outline"
            disabled={running || !allShotsApproved}
            onClick={runContinuityPass}
            title={
              allShotsApproved
                ? undefined
                : "Every shot must be approved first"
            }
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Link2 className="size-3.5" />
            )}
            Run continuity pass
          </Button>
        </div>
      </div>

      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}

      {notes ? (
        <div className="mt-4 border-t border-border pt-4">
          <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            {checkedAt
              ? `Checked ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(checkedAt))}`
              : "Last check"}
          </p>
          <p className="mt-1 text-sm whitespace-pre-line text-muted-foreground">
            {notes}
          </p>
        </div>
      ) : !allShotsApproved ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Not every shot is approved yet — nothing to check across the
          sequence.
        </p>
      ) : null}
    </div>
  );
}
