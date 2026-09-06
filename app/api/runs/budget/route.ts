import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { callRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// What is left under the spending ceiling. Surfaced at the point of consent so a
// refused run is predictable rather than a 402 out of nowhere.
export async function GET() {
  const unauthorised = await requireApiSession();
  if (unauthorised) return unauthorised;

  const { status, body } = await callRuntime("/runs/budget");
  return NextResponse.json(body, { status });
}
