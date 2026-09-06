import JSZip from "jszip";
import { NextRequest } from "next/server";
import { getExportPackage } from "@/lib/export";
import { addShotFolder, zipResponse } from "@/lib/export-zip";
import { requireApiSession } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ shotId: string }> },
) {
  const unauthorised = await requireApiSession();
  if (unauthorised) return unauthorised;

  const { shotId } = await params;
  const pkg = await getExportPackage(shotId);
  if (!pkg) {
    return new Response("Shot not found", { status: 404 });
  }

  const zip = new JSZip();
  await addShotFolder(zip, pkg);
  return zipResponse(zip, `${pkg.shot.code}_export.zip`);
}
