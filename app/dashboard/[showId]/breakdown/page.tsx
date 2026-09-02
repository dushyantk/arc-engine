import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check, ListTree, Lock, Plus, RefreshCw, X } from "lucide-react";
import {
  getLatestBreakdown,
  getScripts,
  getShowDetail,
  type BreakdownShotPlan,
} from "@/lib/data";
import { proposeBreakdown, submitBreakdownApproval } from "@/lib/actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const dynamic = "force-dynamic";

// What each planned action means for the reader, in the reader's terms. The
// wording matters most for skip_protected: it is the one case where the system
// deliberately ignores the agent, and silence there would read like a bug.
const ACTION_COPY: Record<
  BreakdownShotPlan["action"],
  { label: string; tone: string; note: string }
> = {
  create: {
    label: "new",
    tone: "text-primary",
    note: "Will be created.",
  },
  update_brief: {
    label: "brief updated",
    tone: "text-warning",
    note: "Exists with no generated versions, so its brief will be replaced.",
  },
  skip_protected: {
    label: "protected",
    tone: "text-success",
    note: "Has generated versions. Its brief is left exactly as it is — a re-plan does not rewrite a shot that has been paid for.",
  },
  skip_unchanged: {
    label: "unchanged",
    tone: "text-muted-foreground",
    note: "Already exists with this brief. Nothing to write.",
  },
};

export default async function BreakdownPage({
  params,
}: {
  params: Promise<{ showId: string }>;
}) {
  const { showId } = await params;
  const [detail, scripts, { data: latest, runtimeReachable }] = await Promise.all([
    getShowDetail(showId),
    getScripts(showId),
    getLatestBreakdown(showId),
  ]);
  if (!detail) notFound();

  const { show } = detail;
  const approvedScript = scripts.find((s) => s.status === "approved") ?? null;
  const proposeForShow = proposeBreakdown.bind(null, showId);

  const shots = latest?.plan.sequences.flatMap((s) => s.shots) ?? [];
  const counts = {
    create: shots.filter((s) => s.action === "create").length,
    update: shots.filter((s) => s.action === "update_brief").length,
    protected: shots.filter((s) => s.action === "skip_protected").length,
    unchanged: shots.filter((s) => s.action === "skip_unchanged").length,
  };
  const writesNothing = counts.create === 0 && counts.update === 0;
  const isOpen = latest?.status === "draft";

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <Link
        href={`/dashboard/${showId}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {show.name}
      </Link>

      <div className="mt-4 border-b border-border pb-6">
        <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
          Breakdown
        </p>
        <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
          What this show is made of
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          The breakdown agent reads the approved script and proposes the sequences, shots
          and reference assets it implies. Proposing is cheap and writes nothing.
          Approving creates real sequences and shots — which is why you see the whole plan,
          shot by shot, before the button exists.
        </p>
      </div>

      {!runtimeReachable ? (
        <p className="mt-8 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Could not reach the agent runtime, so there is nothing to show — this page cannot
          tell whether a breakdown exists. Start it with{" "}
          <code className="font-mono">pnpm dev:api</code> and reload.
        </p>
      ) : null}

      {runtimeReachable && !approvedScript ? (
        <div className="mt-8 rounded-md border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            This show has no approved script yet. A breakdown is made from the script that
            was signed off, so that comes first.
          </p>
          <Link
            href={`/dashboard/${showId}/script`}
            className={`${buttonVariants({ variant: "outline" })} mt-4`}
          >
            Write and approve a script
          </Link>
        </div>
      ) : null}

      {runtimeReachable && approvedScript ? (
        <form action={proposeForShow} className="mt-8 flex items-center justify-between gap-4 rounded-md border border-border bg-card px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              Break down script v{approvedScript.versionNumber}
            </p>
            <p className="mt-0.5 max-w-[60ch] text-xs text-muted-foreground">
              A fraction of a cent, text only. Each pass is a new version and nothing is
              overwritten.
            </p>
          </div>
          <Button type="submit">
            {latest ? <RefreshCw className="size-4" /> : <ListTree className="size-4" />}
            {latest ? "Re-break down" : "Break it down"}
          </Button>
        </form>
      ) : null}

      {latest ? (
        <article className="mt-8 rounded-md border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-medium">v{latest.version_number}</span>
              <Badge variant={latest.status === "materialised" ? "default" : "outline"}>
                {latest.status === "materialised" ? <Check className="size-3" /> : null}
                {latest.status}
              </Badge>
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">
              {shots.length} shots · {latest.plan.sequences.length} sequences
            </span>
          </div>

          {/* What approving would actually do, before the button that does it. */}
          <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-4">
            {[
              { label: "create", value: counts.create, icon: Plus, tone: "text-primary" },
              { label: "update brief", value: counts.update, icon: RefreshCw, tone: "text-warning" },
              { label: "protected", value: counts.protected, icon: Lock, tone: "text-success" },
              { label: "unchanged", value: counts.unchanged, icon: Check, tone: "text-muted-foreground" },
            ].map((cell) => (
              <div key={cell.label} className="bg-card px-4 py-3">
                <p className="flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                  <cell.icon className="size-3" />
                  {cell.label}
                </p>
                <p className={`mt-1 font-mono text-lg ${cell.value > 0 ? cell.tone : "text-muted-foreground/40"}`}>
                  {cell.value}
                </p>
              </div>
            ))}
          </div>

          <div className="px-4 py-4">
            {counts.protected > 0 ? (
              <p className="mb-4 rounded-sm border border-success/40 bg-success/10 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-success">
                {counts.protected} shot{counts.protected === 1 ? " has" : "s have"} generated
                versions and will not be touched. Re-planning is cheap; the footage was not.
              </p>
            ) : null}

            {latest.plan.orphaned.length > 0 ? (
              <p className="mb-4 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-warning">
                This breakdown no longer proposes {latest.plan.orphaned.join(", ")}. Nothing
                here deletes them — they stay exactly as they are, and removing one is a
                decision you make yourself.
              </p>
            ) : null}

            {latest.plan.sequences.map((seq) => (
              <div key={seq.code} className="mb-5 last:mb-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-medium">{seq.code}</span>
                  <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                    {seq.action === "create" ? "new sequence" : "existing"}
                  </span>
                </div>
                <p className="mt-0.5 max-w-[70ch] text-xs text-muted-foreground">
                  {seq.description}
                </p>

                <div className="mt-2 flex flex-col gap-px overflow-hidden rounded-sm border border-border bg-border">
                  {seq.shots.map((shot) => {
                    const copy = ACTION_COPY[shot.action];
                    return (
                      <div key={shot.code} className="bg-background px-3 py-2.5">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-xs font-medium">{shot.code}</span>
                          <span className={`font-mono text-[10px] tracking-wide uppercase ${copy.tone}`}>
                            {copy.label}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {shot.screen_direction}
                          </span>
                        </div>
                        {/* For every action but skip_protected the brief shown is
                            what the shot will actually carry. For a protected shot
                            it is the proposal that gets thrown away - printing it
                            plainly would read as the shot's brief and quietly
                            misrepresent what approving does. */}
                        {shot.action === "skip_protected" ? (
                          <p className="mt-1 font-mono text-[10px] tracking-wide text-muted-foreground/60 uppercase">
                            Proposed, not applied
                          </p>
                        ) : null}
                        <p
                          className={`mt-1 max-w-[75ch] text-xs leading-relaxed ${
                            shot.action === "skip_protected"
                              ? "text-muted-foreground/45 line-through decoration-muted-foreground/30"
                              : "text-muted-foreground"
                          }`}
                        >
                          {shot.brief}
                        </p>
                        <p className="mt-1 font-mono text-[10.5px] text-muted-foreground/70">
                          {copy.note}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {latest.breakdown.assets.length > 0 ? (
              <div className="mt-6 border-t border-border pt-4">
                <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                  Reference assets this needs
                </p>
                <p className="mt-1 max-w-[70ch] text-xs text-muted-foreground">
                  Proposed, not created. Nothing here generates a sheet or spends anything —
                  these are what the sequence would need locked references for.
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  {latest.breakdown.assets.map((asset) => (
                    <div key={asset.name} className="rounded-sm border border-border px-3 py-2">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                          {asset.type}
                        </span>
                        <span className="text-xs font-medium">{asset.name}</span>
                      </div>
                      <p className="mt-1 max-w-[70ch] text-xs text-muted-foreground">
                        {asset.why_needed}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {isOpen ? (
              <form
                action={submitBreakdownApproval.bind(null, showId, latest.breakdown_id)}
                className="mt-6 border-t border-border pt-4"
              >
                <label
                  htmlFor="breakdown-reason"
                  className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase"
                >
                  Reason (required to reject)
                </label>
                <Textarea
                  id="breakdown-reason"
                  name="reason"
                  rows={2}
                  maxLength={2000}
                  placeholder="Why this shot list is or isn't what the show should be built from."
                  className="mt-2"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="submit" name="decision" value="approved" disabled={writesNothing}>
                    <Check className="size-4" />
                    Approve — create {counts.create > 0 ? `${counts.create} shots` : "these rows"}
                  </Button>
                  <Button type="submit" name="decision" value="rejected" variant="outline">
                    <X className="size-4" />
                    Reject
                  </Button>
                </div>
                {writesNothing ? (
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    This plan would write nothing — every shot it proposes already exists
                    unchanged or is protected. Approving it would do nothing, so it is
                    disabled rather than pretending to work.
                  </p>
                ) : null}
              </form>
            ) : null}

            {latest.status === "materialised" ? (
              <p className="mt-6 border-t border-border pt-4 font-mono text-[11px] text-muted-foreground">
                Already materialised. Its shots are real and live on the show page — re-break
                down above to propose a new version against the current script.
              </p>
            ) : null}
          </div>
        </article>
      ) : null}

      {runtimeReachable && approvedScript && !latest ? (
        <p className="mt-8 rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No breakdown yet. Break down the approved script above and review what it
          proposes before anything is created.
        </p>
      ) : null}
    </div>
  );
}
