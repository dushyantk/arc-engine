import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionEvents } from "@/lib/data";
import { LiveSessionLog } from "@/components/live-session-log";

export const dynamic = "force-dynamic";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  // No not-found gate on an empty result: a run genuinely in progress can
  // be opened before its first agent call has finished and logged
  // anything. LiveSessionLog's own empty state covers "nothing yet."
  const events = await getSessionEvents(runId);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Link
        href="/dashboard/sessions"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Session log
      </Link>

      <h1 className="font-heading mt-4 text-xl font-semibold tracking-tight">
        Session {runId}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connects live to this run&apos;s log. If the run already finished,
        this replays what actually happened; if it&apos;s still going,
        new steps stream in as they&apos;re logged.
      </p>

      <div className="mt-8">
        <LiveSessionLog runId={runId} initialEvents={events} />
      </div>
    </div>
  );
}
