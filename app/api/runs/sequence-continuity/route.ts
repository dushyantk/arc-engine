import { NextRequest, NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-auth";
import { requireOperatorApi } from "@/lib/auth-guards";
import { callRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const unauthorised = await requireApiSession();
  if (unauthorised) return unauthorised;
  const notOperator = await requireOperatorApi("start a continuity pass");
  if (notOperator) return notOperator;

  const payload = await request.json();
  const { status, body } = await callRuntime("/runs/sequence-continuity", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
