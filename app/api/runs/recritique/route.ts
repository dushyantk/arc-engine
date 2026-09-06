import { NextRequest, NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { callRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const unauthorised = await requireApiSession();
  if (unauthorised) return unauthorised;

  const payload = await request.json();
  const { status, body } = await callRuntime("/runs/recritique", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
