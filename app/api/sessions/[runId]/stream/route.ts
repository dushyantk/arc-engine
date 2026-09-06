import { NextRequest } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { getSessionEvents } from "@/lib/data";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1000;
// Safety cap so an abandoned tab (or a proxy that swallows the abort
// signal) doesn't hold a polling loop open forever - not a real-time
// guarantee problem, just resource hygiene for a single-operator beta.
const MAX_ITERATIONS = 30 * 60; // 30 minutes at 1s/poll

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const unauthorised = await requireApiSession();
  if (unauthorised) return unauthorised;

  const { runId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let cursor: string | undefined;
      let closed = false;
      request.signal.addEventListener("abort", () => {
        closed = true;
      });

      for (let i = 0; i < MAX_ITERATIONS && !closed; i++) {
        try {
          const events = await getSessionEvents(runId, cursor);
          for (const event of events) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
            cursor = event.createdAt;
          }
        } catch {
          // Transient ClickHouse hiccup - skip this tick, try again next poll.
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (!closed) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
