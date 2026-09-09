import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCostBreakdown, getShotDetail, getShotSpend } from "@/lib/data";
import { submitHumanApproval, updateShotBrief } from "@/lib/actions";
import { ShotStatusBadge, VersionStatusBadge } from "@/components/status-badge";
import { ShotVideo } from "@/components/shot-video";
import { QcReport } from "@/components/qc-report";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StartRunPanel } from "@/components/start-run-panel";
import { VersionRunActions } from "@/components/version-run-actions";
import { HumanApprovalActions } from "@/components/human-approval-actions";

export const dynamic = "force-dynamic";

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default async function ShotDetailPage({
  params,
}: {
  params: Promise<{ showId: string; sequenceCode: string; shotCode: string }>;
}) {
  const { showId, sequenceCode, shotCode } = await params;
  const [detail, shotSpend, costs] = await Promise.all([
    getShotDetail(showId, sequenceCode, shotCode),
    getShotSpend(shotCode),
    getCostBreakdown(),
  ]);

  if (!detail) notFound();

  const { shot, sequence, show, versions, origin, lockedReferenceCount } = detail;
  const updateBriefForShot = updateShotBrief.bind(
    null,
    showId,
    sequenceCode,
    shot.code,
    shot.id,
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <Link
        href={`/dashboard/${showId}/${sequenceCode}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {sequence?.code ?? "Sequence"}
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {shot.code}
          </h1>
          {shot.screenDirection ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Screen direction: {shot.screenDirection}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <Link
            href={`/dashboard/${showId}/${sequenceCode}/${shot.code}/export`}
            className="text-sm text-primary hover:underline"
          >
            Export &rarr;
          </Link>
          <ShotStatusBadge status={shot.status} testId="shot-status" />
          <StartRunPanel
            shotCode={shot.code}
            showName={show?.name ?? ""}
            hasBrief={Boolean(shot.brief)}
            lockedReferenceCount={lockedReferenceCount}
            spend={{
              calls: shotSpend.calls,
              spendUsd: shotSpend.spendUsd,
              generations: shotSpend.generations,
              totalSpendUsd: costs.summary.totalSpendUsd,
              codeIsAmbiguous: shotSpend.codeIsAmbiguous,
            }}
          />
        </div>
      </div>

      {/* A shot that was proposed rather than typed says so, and links to the
          proposal. The column has been recording this since the breakdown agent
          landed; without this it was an answer only the database could give. */}
      {origin ? (
        <p className="mt-6 rounded-md border border-border bg-secondary/60 px-4 py-2.5 font-mono text-[11.5px] text-muted-foreground">
          Proposed by{" "}
          <Link
            href={`/dashboard/${showId}/breakdown#history`}
            className="text-foreground underline underline-offset-2 hover:text-primary"
          >
            breakdown v{origin.versionNumber}
          </Link>{" "}
          on {origin.createdAt.toISOString().slice(0, 10)}, not authored by hand.
        </p>
      ) : null}

      <div className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Brief
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The scene goal a run plans against. Editing this doesn&apos;t
          rewrite past versions — each one keeps a stamp of whatever brief
          was live when it was generated.
        </p>
        <form action={updateBriefForShot} className="mt-3">
          <Textarea
            name="brief"
            defaultValue={shot.brief ?? ""}
            placeholder="Describe what this shot needs to accomplish — Arc Engine plans the actual generation prompt from this."
            rows={3}
            className="font-mono text-sm"
          />
          <div className="mt-2 flex justify-end">
            <Button type="submit" size="sm">
              Save brief
            </Button>
          </div>
        </form>
      </div>

      <div className="mt-8 flex flex-col gap-8">
        {versions.map((version) => (
          // Same reasoning as the reference cards: every version card repeats
          // the same "Human review" control, and a version card has no
          // accessible name of its own to scope to.
          <div
            key={version.id}
            data-testid="version-card"
            data-version-number={version.versionNumber}
            className="rounded-lg border border-border bg-card p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-mono text-sm font-semibold">
                v{String(version.versionNumber).padStart(3, "0")}
              </p>
              <div className="flex items-center gap-3">
                <VersionRunActions
                  shotCode={shot.code}
                  showName={show?.name ?? ""}
                  versionNumber={version.versionNumber}
                />
                <HumanApprovalActions
                  versionLabel={`v${String(version.versionNumber).padStart(3, "0")}`}
                  submitAction={submitHumanApproval.bind(
                    null,
                    showId,
                    sequenceCode,
                    shot.code,
                    shot.id,
                    version.id,
                    version.versionNumber,
                    show?.name ?? "",
                  )}
                />
                <VersionStatusBadge status={version.status} />
              </div>
            </div>

            {version.videoAssetUrl ? (
              <div className="mt-4">
                <ShotVideo
                  src={`/api/media/${version.videoAssetUrl}`}
                  label={`${shot.code} version ${version.versionNumber}`}
                />
              </div>
            ) : null}

            {version.briefUsed ? (
              <div className="mt-4">
                <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                  Brief used
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {version.briefUsed}
                </p>
              </div>
            ) : null}

            <div className="mt-4">
              <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                Generation prompt
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {version.generationPrompt}
              </p>
            </div>

            {version.qcFindings.length > 0 ? (
              <div className="mt-4">
                <QcReport findings={version.qcFindings} />
              </div>
            ) : null}

            {version.events.length > 0 ? (
              <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
                {version.events.map((event) => (
                  <div key={event.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                        {event.actor}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatDate(event.createdAt)}
                      </span>
                    </div>
                    {event.reason ? (
                      <p className="mt-1 text-muted-foreground">
                        {event.reason}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
