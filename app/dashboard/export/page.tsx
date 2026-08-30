import Link from "next/link";
import { AlertTriangle, Download, Package } from "lucide-react";
import { getExportableWork } from "@/lib/data";
import { ShotStatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

type ShotStatus = Parameters<typeof ShotStatusBadge>[0]["status"];

export default async function ExportPage() {
  const sequences = await getExportableWork();
  const totalApproved = sequences.reduce((sum, s) => sum + s.approvedCount, 0);
  const totalShots = sequences.reduce((sum, s) => sum + s.shots.length, 0);

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="border-b border-border pb-6">
        <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
          Export
        </p>
        <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
          VFX handoff packages
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          A shot ships as <code className="font-mono text-foreground">plate/ gen/ refs/
          metadata/</code> plus a templated Nuke script, with the provenance of the run that
          approved it. A shot becomes exportable when it is approved — that gate is the
          product, so nothing here lets you bundle work that hasn&apos;t cleared it.
        </p>
        <p className="mt-3 font-mono text-xs text-muted-foreground tabular-nums">
          {totalApproved} of {totalShots} shots approved across {sequences.length} sequence
          {sequences.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="mt-8 flex flex-col gap-4">
        {sequences.map((sequence) => (
          <div
            key={sequence.sequenceId}
            className="rounded-md border border-border bg-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <Link
                  href={`/dashboard/${sequence.showId}/${sequence.sequenceCode}`}
                  className="font-mono text-sm font-medium hover:text-primary"
                >
                  {sequence.sequenceCode}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">
                  {sequence.showName}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {sequence.approvedCount} / {sequence.shots.length} approved
                </span>
                {sequence.approvedCount > 0 ? (
                  <a
                    href={`/api/export/sequence/${sequence.sequenceId}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <Package className="size-4" />
                    {sequence.wholeSequenceApproved
                      ? "Download sequence"
                      : `Download ${sequence.approvedCount} approved`}
                  </a>
                ) : (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    Nothing to bundle
                  </span>
                )}
              </div>
            </div>

            <div className="divide-y divide-border/60">
              {sequence.shots.map((shot) => {
                const exportable = shot.status === "approved";
                return (
                  <div
                    key={shot.shotId}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[13px]">{shot.shotCode}</span>
                      <ShotStatusBadge status={shot.status as ShotStatus} />
                      {exportable && shot.approvedVersionNumber !== null ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          v{shot.approvedVersionNumber}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-3">
                      {exportable && !shot.hasStoredFootage ? (
                        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-warning">
                          <AlertTriangle className="size-3" />
                          approved, no stored footage
                        </span>
                      ) : null}
                      {exportable ? (
                        <a
                          href={`/api/export/${shot.shotId}`}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                          <Download className="size-4" />
                          Package
                        </a>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          not approved
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {sequence.shots.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No shots in this sequence yet.
                </p>
              ) : null}
            </div>
          </div>
        ))}

        {sequences.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No sequences yet. Create one from a show to start.
          </p>
        ) : null}
      </div>

      {totalApproved === 0 && totalShots > 0 ? (
        <p className="mt-6 max-w-[70ch] rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          Nothing is exportable right now because no shot has cleared approval. That is the
          honest state of this sequence, not a missing feature — every shot above is still
          in revision or waiting on a human. Approve a version from its shot page and it
          appears here.
        </p>
      ) : null}
    </div>
  );
}
