import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock, Plus, Unlock } from "lucide-react";
import { getShowDetail } from "@/lib/data";
import { createSequence, setReferenceLock, uploadReferenceAsset } from "@/lib/actions";
import { UploadReferenceDialog } from "@/components/upload-reference-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

export default async function ShowDetailPage({
  params,
}: {
  params: Promise<{ showId: string }>;
}) {
  const { showId } = await params;
  const detail = await getShowDetail(showId);
  if (!detail) notFound();

  const { show, sequences, referenceAssets } = detail;
  const createSequenceForShow = createSequence.bind(null, showId);
  const uploadReferenceForShow = uploadReferenceAsset.bind(null, showId);

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Shows
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            Show
          </p>
          <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
            {show.name}
          </h1>
        </div>
        <Dialog>
          {/* DialogTrigger renders natively (styled via buttonVariants)
              instead of wrapping a <Button> - see app/dashboard/page.tsx
              for why. */}
          <DialogTrigger className={buttonVariants({ size: "sm" })}>
            <Plus className="size-4" />
            New sequence
          </DialogTrigger>
          <DialogContent>
            <form action={createSequenceForShow}>
              <DialogHeader>
                <DialogTitle>New sequence</DialogTitle>
                <DialogDescription>
                  A sequence groups the shots that need to agree with each
                  other.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 flex flex-col gap-3">
                <div>
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    name="code"
                    placeholder="SQ020"
                    required
                    autoFocus
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    name="description"
                    placeholder="What happens in this sequence"
                    className="mt-1.5"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit">Create sequence</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-8">
        <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Sequences
        </h2>
        <div className="mt-3 flex flex-col gap-2">
          {sequences.map(({ sequence, shotCount, approvedCount }) => (
            <Link
              key={sequence.id}
              href={`/dashboard/${showId}/${sequence.code}`}
              className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-ring"
            >
              <div>
                <p className="font-mono text-sm font-medium">
                  {sequence.code}
                </p>
                {sequence.description ? (
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {sequence.description}
                  </p>
                ) : null}
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                {approvedCount} / {shotCount} approved
              </p>
            </Link>
          ))}
          {sequences.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No sequences yet.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              References
            </h2>
            <p className="mt-1 max-w-[62ch] text-xs text-muted-foreground">
              Locked references are the canon a run is judged against — the planner
              and the generation adapter only ever see locked ones. Unlock to take
              an image out of canon without deleting its lineage.
            </p>
          </div>
          <UploadReferenceDialog action={uploadReferenceForShow} />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {referenceAssets.map((ref) => (
            <div
              key={ref.id}
              className={`overflow-hidden rounded-md border bg-card ${
                ref.lockedAt ? "border-border" : "border-warning/40"
              }`}
            >
              <div className="relative aspect-video bg-secondary">
                <Image
                  src={`/api/media/${ref.imageUrl}`}
                  alt={ref.name}
                  fill
                  sizes="(min-width: 640px) 33vw, 100vw"
                  className={`object-cover ${ref.lockedAt ? "" : "opacity-45 saturate-50"}`}
                  unoptimized
                />
                {!ref.lockedAt ? (
                  <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-sm bg-background/85 px-1.5 py-0.5 font-mono text-[10px] text-warning">
                    <Unlock className="size-3" />
                    NOT IN CANON
                  </span>
                ) : null}
              </div>
              <div className="p-3">
                <p className="text-sm font-medium">{ref.name}</p>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <Badge variant="outline">{ref.type}</Badge>
                  {ref.lockedAt ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-success">
                      <Lock className="size-3" />
                      Locked
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-warning">Unlocked</span>
                  )}
                </div>
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {ref.lockedAt ? (
                    <>
                      {ref.lockedAt.toISOString().slice(0, 10)}
                      {ref.approvedBy ? ` · ${ref.approvedBy}` : ""}
                    </>
                  ) : (
                    "Not used by any run while unlocked"
                  )}
                </p>
                <form
                  action={setReferenceLock.bind(null, showId, ref.id)}
                  className="mt-2.5"
                >
                  <input
                    type="hidden"
                    name="locked"
                    value={ref.lockedAt ? "false" : "true"}
                  />
                  <Button type="submit" variant="outline" size="sm" className="w-full">
                    {ref.lockedAt ? "Unlock" : "Lock as canon"}
                  </Button>
                </form>
              </div>
            </div>
          ))}
          {referenceAssets.length === 0 ? (
            <p className="col-span-full rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No reference images yet. Upload the character, prop, environment or
              palette plates this show should be held to.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
