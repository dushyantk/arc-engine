import Image from "next/image";
import Link from "next/link";
import { Film } from "lucide-react";
import { getSequenceOverview } from "@/lib/data";
import { ShotStatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

// SH020 is the only shot with a real, stored generation in this beta seed.
// SH010 and SH030 carry their real Postgres history (prompts, approval
// events) but no uploaded video bytes yet, hence the placeholder treatment
// below rather than pretending there's footage to show.
const REAL_THUMBNAILS: Record<string, string> = {
  SH020: "/proof/hero.jpg",
};

export default async function DashboardPage() {
  const overview = await getSequenceOverview();

  if (!overview) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-24 text-center">
        <p className="text-sm text-muted-foreground">
          No sequence found. Run <code className="font-mono">pnpm db:seed</code>{" "}
          against the local stack first.
        </p>
      </div>
    );
  }

  const { show, sequence, shots } = overview;
  const approvedCount = shots.filter((s) => s.status === "approved").length;

  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {show.name}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {sequence.code}
          </h1>
          {sequence.description ? (
            <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
              {sequence.description}
            </p>
          ) : null}
        </div>
        <p className="font-mono text-sm text-muted-foreground">
          {approvedCount} / {shots.length} approved
        </p>
      </div>

      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {shots.map((shot) => {
          const thumbnail = REAL_THUMBNAILS[shot.code];
          return (
            <Link
              key={shot.id}
              href={`/dashboard/${shot.code}`}
              className="group overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-ring"
            >
              <div className="relative aspect-video overflow-hidden bg-secondary">
                {thumbnail ? (
                  <Image
                    src={thumbnail}
                    alt={`Latest generated frame from ${shot.code}`}
                    fill
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                    <Film className="size-5" />
                    <span className="font-mono text-[11px] uppercase tracking-wide">
                      Seed data, not yet generated
                    </span>
                  </div>
                )}
                <span className="absolute bottom-2 left-2 rounded-sm bg-background/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {shot.code}
                </span>
              </div>
              <div className="flex items-center justify-between p-4">
                <div>
                  <p className="font-mono text-sm font-medium">{shot.code}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {shot.versions.length} version
                    {shot.versions.length === 1 ? "" : "s"}
                    {shot.latestVersion
                      ? ` · v${shot.latestVersion.versionNumber}`
                      : ""}
                  </p>
                </div>
                <ShotStatusBadge status={shot.status} />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
