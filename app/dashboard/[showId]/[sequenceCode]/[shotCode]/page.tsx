import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getShotDetail } from "@/lib/data";
import { ShotStatusBadge, VersionStatusBadge } from "@/components/status-badge";
import { ShotVideo } from "@/components/shot-video";
import { QcReport } from "@/components/qc-report";

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
  const detail = await getShotDetail(showId, sequenceCode, shotCode);

  if (!detail) notFound();

  const { shot, sequence, versions } = detail;

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
          <ShotStatusBadge status={shot.status} />
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-8">
        {versions.map((version) => (
          <div
            key={version.id}
            className="rounded-lg border border-border bg-card p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-mono text-sm font-semibold">
                v{String(version.versionNumber).padStart(3, "0")}
              </p>
              <VersionStatusBadge status={version.status} />
            </div>

            {version.videoAssetUrl ? (
              <div className="mt-4">
                <ShotVideo
                  src={`/api/media/${version.videoAssetUrl}`}
                  label={`${shot.code} version ${version.versionNumber}`}
                />
              </div>
            ) : null}

            <p className="mt-4 text-sm text-muted-foreground">
              {version.generationPrompt}
            </p>

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
