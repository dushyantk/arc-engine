"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Film, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Real Veo shots this project has actually generated have all run ~8
// seconds - used only to turn real $/sec pricing into a real-ish estimate
// up front. The number actually billed (logged to agent_decision_log) can
// differ; this is a planning estimate, not a quote.
const ASSUMED_SECONDS = 8;

const TIER_LABELS: Record<string, string> = {
  "veo-3.1-generate-preview": "Standard",
  "veo-3.1-fast-generate-preview": "Fast",
  "veo-3.1-lite-generate-preview": "Lite",
};

export type ShotSpendSummary = {
  calls: number;
  spendUsd: number;
  generations: number;
  totalSpendUsd: number;
  /** True when this shot code exists in more than one show. The decision log
   *  anchors rows by shot code only, so the figure then covers every show that
   *  uses the code, and the panel has to say so rather than imply it is this
   *  shot's own spend. */
  codeIsAmbiguous: boolean;
};

export function StartRunPanel({
  shotCode,
  showName,
  hasBrief,
  spend,
}: {
  shotCode: string;
  showName: string;
  hasBrief: boolean;
  /** What this shot and the whole system have cost so far, so the consent
   *  checkbox below is an informed one rather than a bare confirmation. */
  spend?: ShotSpendSummary;
}) {
  const router = useRouter();
  const [pricing, setPricing] = useState<Record<string, number> | null>(null);
  const [tier, setTier] = useState<string>("veo-3.1-generate-preview");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/runs/pricing")
      .then((r) => r.json())
      .then((data) => setPricing(data))
      .catch(() => setPricing(null));
  }, []);

  const perSecond = pricing?.[tier];
  const estimate = perSecond !== undefined ? perSecond * ASSUMED_SECONDS : null;

  async function handleStart() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/runs/generate", {
        method: "POST",
        body: JSON.stringify({
          shot_code: shotCode,
          show_name: showName,
          model_tier: tier,
          confirm_cost: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ?? "Failed to start run.");
        setSubmitting(false);
        return;
      }
      router.push(`/dashboard/sessions/${data.run_id}`);
    } catch {
      setError("Could not reach the agent runtime — is it running (pnpm dev:api)?");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:pointer-events-none disabled:opacity-50"
        disabled={!hasBrief}
        title={hasBrief ? undefined : "Author a brief above first"}
      >
        <Film className="size-4" />
        Start run
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a real generation</DialogTitle>
          <DialogDescription>
            Plans from the brief above and makes a real, billed Veo call for{" "}
            {shotCode}. This is not a preview or a simulation.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-foreground">
              Model tier
            </p>
            <div className="flex flex-col gap-1.5">
              {(pricing ? Object.keys(pricing) : Object.keys(TIER_LABELS)).map(
                (t) => (
                  <label
                    key={t}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm has-[:checked]:border-ring has-[:checked]:bg-secondary"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="tier"
                        value={t}
                        checked={tier === t}
                        onChange={() => setTier(t)}
                      />
                      {TIER_LABELS[t] ?? t}
                    </span>
                    {pricing?.[t] !== undefined ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        ${(pricing[t] * ASSUMED_SECONDS).toFixed(2)} for {ASSUMED_SECONDS}s
                      </span>
                    ) : null}
                  </label>
                ),
              )}
            </div>
          </div>

          <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
            Estimated cost:{" "}
            <span className="font-mono font-medium text-foreground">
              {estimate !== null ? `~$${estimate.toFixed(2)}` : "loading real pricing…"}
            </span>{" "}
            for an ~{ASSUMED_SECONDS}s shot, plus a few cents of Gemini
            planning/critique cost. Real, billed, not a placeholder number.
          </p>

          {/* Consent is only informed if it says what has already been spent
              here. Attributed by shot code, which is what the decision log
              records - see getShotSpend(). */}
          {spend && spend.calls > 0 ? (
            <p className="mt-2 rounded-sm border border-border bg-secondary/60 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
              Logged against shot code {shotCode}:{" "}
              <span className="text-foreground">${spend.spendUsd.toFixed(2)}</span> across{" "}
              {spend.calls} calls and {spend.generations} generation
              {spend.generations === 1 ? "" : "s"}. Total spend to date{" "}
              <span className="text-foreground">${spend.totalSpendUsd.toFixed(2)}</span>.
              {spend.codeIsAmbiguous ? (
                <>
                  {" "}
                  <span className="text-warning">
                    That code exists in more than one show, so this figure covers all of
                    them — the decision log records the shot code, not the show.
                  </span>
                </>
              ) : null}
            </p>
          ) : null}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            I understand this spends real money and want to proceed.
          </label>

          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            onClick={handleStart}
            disabled={!confirmed || submitting || estimate === null}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Starting…
              </>
            ) : (
              "Start real generation"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
