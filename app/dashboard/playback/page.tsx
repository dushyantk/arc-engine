import { getPlaybackSequence } from "@/lib/data";
import { SequencePlayer } from "@/components/sequence-player";

export const dynamic = "force-dynamic";

export default async function PlaybackPage() {
  const data = await getPlaybackSequence();

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-24 text-center">
        <p className="text-sm text-muted-foreground">No sequence found.</p>
      </div>
    );
  }

  const { sequence, items } = data;
  const approvedCount = items.filter((item) => item.approvedVersion).length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
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
