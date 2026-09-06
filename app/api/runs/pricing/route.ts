import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { callRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauthorised = await requireApiSession();
  if (unauthorised) return unauthorised;

  const { status, body } = await callRuntime("/runs/pricing");
  return NextResponse.json(body, { status });
}
