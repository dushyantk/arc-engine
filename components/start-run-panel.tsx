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

type CatalogModel = {
  name: string;
  priced: boolean;
  usd_per_second: number | null;
  recommended: boolean;
  preview: boolean;
};

type BudgetStatus = {
  ceiling_usd: number | null;
  spent_usd: number;
  remaining_usd: number | null;
  enforced: boolean;
};

type ModelCatalog = {
  source: "live" | "fallback";
  note: string | null;
  video: CatalogModel[];
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
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  // Distinct from "still loading": saying "asking the API" after the request
  // already failed is the kind of small lie this product keeps arguing against.
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  // Empty until the catalogue answers: the tier is whatever the API actually
  // offers and recommends, not a name compiled in here that may no longer exist.
  const [tier, setTier] = useState<string>("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/runs/models")
      .then((r) => r.json())
      .then((data: ModelCatalog) => {
        setCatalog(data);
        const preferred =
          data.video.find((m) => m.recommended && m.priced) ??
          data.video.find((m) => m.priced);
        if (preferred) setTier(preferred.name);
      })
      .catch(() => {
        setCatalog(null);
        setCatalogFailed(true);
      });
  }, []);

  useEffect(() => {
    fetch("/api/runs/budget")
      .then((r) => r.json())
      .then((data: BudgetStatus) => setBudget(data))
      .catch(() => setBudget(null));
  }, []);

  const selected = catalog?.video.find((m) => m.name === tier) ?? null;
  const perSecond = selected?.usd_per_second ?? null;
  const estimate = perSecond !== null ? perSecond * ASSUMED_SECONDS : null;

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
              {catalog === null && !catalogFailed ? (
                <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                  Asking the API which models this key can reach…
                </p>
              ) : null}

              {catalogFailed ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                  Could not reach the agent runtime, so there is no model list and no
                  price to consent to. Start it with{" "}
                  <code className="font-mono">pnpm dev:api</code> and reopen this.
                </p>
              ) : null}

              {catalog?.video.map((model) => (
                <label
                  key={model.name}
                  className={`flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm has-[:checked]:border-ring has-[:checked]:bg-secondary ${
                    model.priced ? "" : "opacity-60"
                  }`}
                  title={
                    model.priced
                      ? undefined
                      : "No price on record for this model, so a run on it could not be costed"
                  }
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="tier"
                      value={model.name}
                      checked={tier === model.name}
                      onChange={() => setTier(model.name)}
                      // An unpriced model would bill for real and log $0.00.
                      // Not selectable until it has a rate.
                      disabled={!model.priced}
                    />
                    {TIER_LABELS[model.name] ?? model.name}
                    {model.recommended ? (
                      <span className="font-mono text-[10px] text-primary">DEFAULT</span>
                    ) : null}
                  </span>
                  {model.priced && model.usd_per_second !== null ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      ${(model.usd_per_second * ASSUMED_SECONDS).toFixed(2)} for{" "}
                      {ASSUMED_SECONDS}s
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-warning">no price on record</span>
                  )}
                </label>
              ))}
            </div>

            {catalog?.source === "fallback" ? (
              <p className="mt-1.5 font-mono text-[11px] text-warning">
                {catalog.note ?? "Live model listing unavailable; showing known-priced models."}
              </p>
            ) : null}
          </div>

          <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
            Estimated cost:{" "}
            <span className="font-mono font-medium text-foreground">
              {estimate !== null ? `~$${estimate.toFixed(2)}` : "loading real pricing…"}
            </span>{" "}
            for an ~{ASSUMED_SECONDS}s shot, plus a few cents of Gemini
            planning/critique cost. Real, billed, not a placeholder number.
          </p>

          {budget?.enforced && budget.remaining_usd !== null ? (
            <p
              className={`rounded-sm border px-3 py-2 font-mono text-[11.5px] ${
                estimate !== null && estimate > budget.remaining_usd
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-secondary/60 text-muted-foreground"
              }`}
            >
              ${budget.remaining_usd.toFixed(2)} left of the $
              {budget.ceiling_usd?.toFixed(2)} ceiling.
              {estimate !== null && estimate > budget.remaining_usd
                ? " This run would breach it and will be refused."
                : ""}
            </p>
          ) : null}

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
            // estimate is null when the catalogue has not answered yet or the
            // selected model has no rate - either way there is no informed cost
            // to consent to, so the run cannot start.
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
