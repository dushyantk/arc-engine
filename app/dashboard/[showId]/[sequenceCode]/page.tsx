import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Film, Plus } from "lucide-react";
import { getSequenceDetail, pickShotPoster } from "@/lib/data";
import { createShot } from "@/lib/actions";
import { ShotStatusBadge } from "@/components/status-badge";
import { SequenceContinuityPanel } from "@/components/sequence-continuity-panel";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export const dynamic = "force-dynamic";

export default async function SequenceDetailPage({
  params,
}: {
  params: Promise<{ showId: string; sequenceCode: string }>;
}) {
  const { showId, sequenceCode } = await params;
  const overview = await getSequenceDetail(showId, sequenceCode);
  if (!overview) notFound();

  const { show, sequence, shots } = overview;
  const approvedCount = shots.filter((s) => s.status === "approved").length;
  const nextOrderIndex =
    shots.reduce((max, s) => Math.max(max, s.orderIndex), 0) + 1;
  const createShotForSequence = createShot.bind(
    null,
    showId,
    sequence.id,
    sequence.code,
  );

  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      <Link
        href={`/dashboard/${showId}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {show.name}
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            {show.name}
          </p>
          <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
            {sequence.code}
          </h1>
          {sequence.description ? (
            <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
              {sequence.description}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <p className="font-mono text-sm text-muted-foreground">
              {approvedCount} / {shots.length} approved
            </p>
            {approvedCount > 0 ? (
              <Link
                href={`/dashboard/${showId}/${sequence.code}/playback`}
                className="mt-1 inline-block text-sm text-primary hover:underline"
              >
                Play approved cut &rarr;
              </Link>
            ) : null}
          </div>
          <Dialog>
            {/* DialogTrigger renders natively (styled via buttonVariants)
                instead of wrapping a <Button> - see app/dashboard/page.tsx
                for why. */}
            <DialogTrigger
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              <Plus className="size-4" />
              New shot
            </DialogTrigger>
            <DialogContent>
              <form action={createShotForSequence}>
                <DialogHeader>
                  <DialogTitle>New shot</DialogTitle>
                  <DialogDescription>
                    A shot only gets footage once a run is started against
                    it — this just adds it to the sequence.
                  </DialogDescription>
                </DialogHeader>
                <div className="mt-4 flex flex-col gap-3">
                  <div>
                    <Label htmlFor="code">Code</Label>
                    <Input
                      id="code"
                      name="code"
                      placeholder={`SH${String((shots.length + 1) * 10).padStart(3, "0")}`}
                      required
                      autoFocus
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="orderIndex">Order index</Label>
                    <Input
                      id="orderIndex"
                      name="orderIndex"
                      type="number"
                      defaultValue={nextOrderIndex}
                      min={0}
                      required
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="screenDirection">Screen direction</Label>
                    <select
                      id="screenDirection"
                      name="screenDirection"
                      defaultValue=""
                      className="mt-1.5 h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">Unspecified</option>
                      <option value="L_TO_R">Screen-left to screen-right</option>
                      <option value="R_TO_L">Screen-right to screen-left</option>
                    </select>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit">Create shot</Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <SequenceContinuityPanel
        sequenceId={sequence.id}
        status={sequence.status}
        notes={sequence.continuityNotes}
        checkedAt={sequence.continuityCheckedAt?.toISOString() ?? null}
        allShotsApproved={shots.length > 0 && approvedCount === shots.length}
      />

      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {shots.map((shot) => {
          const poster = pickShotPoster(shot, shot.versions);
          return (
            <Link
              key={shot.id}
              href={`/dashboard/${showId}/${sequence.code}/${shot.code}`}
              className="group overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-ring"
            >
              <div className="relative aspect-video overflow-hidden bg-secondary">
                {poster ? (
                  <Image
                    src={`/api/media/${poster.key}`}
                    alt={`Frame from ${shot.code} v${poster.versionNumber}`}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                    <Film className="size-5" />
                    <span className="font-mono text-[11px] tracking-wide uppercase">
                      No footage generated yet
                    </span>
                  </div>
                )}
                <span className="absolute bottom-2 left-2 rounded-sm bg-background/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {shot.code}
                  {poster ? (
                    <span className="text-muted-foreground"> v{poster.versionNumber}</span>
                  ) : null}
                </span>
                {poster && !poster.representsShotStatus ? (
                  <span
                    className="absolute top-2 right-2 rounded-sm bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-warning"
                    title={`This shot reads ${shot.status}, but that version has no stored footage. Showing v${poster.versionNumber} instead.`}
                  >
                    STAND-IN
                  </span>
                ) : null}
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
        {shots.length === 0 ? (
          <p className="col-span-full rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No shots yet.
          </p>
        ) : null}
      </div>
    </div>
  );
}
