import { NextRequest, NextResponse } from "next/server";
import { callRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const { status, body } = await callRuntime("/runs/generate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status });
}
