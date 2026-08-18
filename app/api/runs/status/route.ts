import { NextResponse } from "next/server";
import { callRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const { status, body } = await callRuntime("/runs/status");
  return NextResponse.json(body, { status });
}
