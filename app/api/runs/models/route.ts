import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { callRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// What models this key can actually reach, asked of the API by the runtime
// rather than read off our own pricing table. Entries carry `priced`; the UI
// must not offer to spend on a model where that is false.
export async function GET() {
  const unauthorised = await requireApiSession();
  if (unauthorised) return unauthorised;

  const { status, body } = await callRuntime("/runs/models");
  return NextResponse.json(body, { status });
}
