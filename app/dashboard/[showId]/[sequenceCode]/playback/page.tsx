import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getPlaybackSequence } from "@/lib/data";
import { SequencePlayer } from "@/components/sequence-player";

export const dynamic = "force-dynamic";

export default async function PlaybackPage({
  params,
}: {
  params: Promise<{ showId: string; sequenceCode: string }>;
}) {
  const { showId, sequenceCode } = await params;
  const data = await getPlaybackSequence(showId, sequenceCode);
  if (!data) notFound();

  const { sequence, items } = data;
  const approvedCount = items.filter((item) => item.approvedVersion).length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Link
        href={`/dashboard/${showId}/${sequenceCode}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {sequence.code}
      </Link>

      <p className="mt-4 font-mono text-xs tracking-wide text-muted-foreground uppercase">
        {sequence.code} &middot; playback
      </p>
      <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
        Approved cut
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {approvedCount} of {items.length} shots have approved footage stored.
        Plays back to back, in shot order.
      </p>

      <div className="mt-8">
        <SequencePlayer items={items} />
      </div>
    </div>
  );
}
