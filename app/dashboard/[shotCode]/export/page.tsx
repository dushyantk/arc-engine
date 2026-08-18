import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, File, Folder } from "lucide-react";
import { getExportPackage } from "@/lib/export";
import { generateNukeScript } from "@/lib/nuke-script";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

function TreeRow({
  depth,
  label,
  dim = false,
}: {
  depth: number;
  label: string;
  dim?: boolean;
}) {
  const isDir = label.endsWith("/");
  return (
    <div
      className={`flex items-center gap-1.5 py-0.5 font-mono text-xs ${
        dim ? "text-muted-foreground/50" : "text-muted-foreground"
      }`}
      style={{ paddingLeft: `${depth * 16}px` }}
    >
      {isDir ? (
        <Folder className="size-3 shrink-0" />
      ) : (
        <File className="size-3 shrink-0" />
      )}
      {label}
    </div>
  );
}

export default async function ExportPage({
  params,
}: {
  params: Promise<{ shotCode: string }>;
}) {
  const { shotCode } = await params;
  const pkg = await getExportPackage(shotCode);
  if (!pkg) notFound();

  const nukeScript = generateNukeScript(pkg);
  const genFilename = pkg.approvedVersion?.hasVideoBytes
    ? `${shotCode}_gen_v${String(pkg.approvedVersion.versionNumber).padStart(3, "0")}.mov`
    : null;
  const realRefs = pkg.referenceAssets.filter((r) => r.hasImageBytes);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <Link
        href={`/dashboard/${shotCode}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {shotCode}
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            {pkg.sequence.code} &middot; export
          </p>
          <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
            VFX handoff package
          </h1>
        </div>
        <Button
          render={
            <a href={`/api/export/${shotCode}`}>
              <Download className="size-4" />
              Download .zip
            </a>
          }
          nativeButton={false}
        />
      </div>

      {!pkg.approvedVersion ? (
        <p className="mt-6 rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          No approved version yet for {shotCode} — this package will contain metadata and a
          template Nuke script only, no generated footage.
        </p>
      ) : !pkg.approvedVersion.hasVideoBytes ? (
        <p className="mt-6 rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {shotCode} v{pkg.approvedVersion.versionNumber} is approved, but no video bytes are
          stored for it (seed data) — <code className="font-mono">gen/</code> will be empty in the
          package.
        </p>
      ) : null}

      <div className="mt-8 grid gap-8 sm:grid-cols-2">
        <div>
          <h2 className="font-heading text-sm font-semibold tracking-wide uppercase">
            Package tree
          </h2>
          <div className="mt-3 rounded-md border border-border bg-card p-4">
            <TreeRow depth={0} label={`${shotCode}/`} />
            <TreeRow depth={1} label="plate/" dim />
            <TreeRow depth={1} label="gen/" />
            {genFilename ? (
              <TreeRow depth={2} label={genFilename} />
            ) : (
              <TreeRow depth={2} label="(empty)" dim />
            )}
            <TreeRow depth={1} label="refs/" />
            {realRefs.length > 0 ? (
              realRefs.map((ref) => (
                <TreeRow
                  key={ref.imageUrl}
                  depth={2}
                  label={ref.imageUrl.split("/").pop() ?? ref.name}
                />
              ))
            ) : (
              <TreeRow depth={2} label="(empty)" dim />
            )}
            <TreeRow depth={1} label="metadata/" />
            <TreeRow depth={2} label="manifest.json" />
            <TreeRow depth={2} label="generation.json" />
            <TreeRow depth={2} label="provenance.json" />
            <TreeRow depth={2} label="qc.json" />
            <TreeRow depth={2} label="notes.json" />
            <TreeRow depth={1} label={`${shotCode}_comp.nk`} />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {pkg.provenance.runId
              ? `Provenance traces to a real run: ${pkg.provenance.events.length} logged agent calls.`
              : "No approval_gate run found for this version — provenance.json will be empty."}
            {" "}
            {pkg.qcFindings.length > 0
              ? `${pkg.qcFindings.length} structured QC findings included.`
              : "No structured per-finding QC data for this version — qc.json falls back to a note pointing at notes.json's prose findings."}
          </p>
        </div>

        <div>
          <h2 className="font-heading text-sm font-semibold tracking-wide uppercase">
            {shotCode}_comp.nk
          </h2>
          <pre className="mt-3 max-h-[480px] overflow-auto rounded-md border border-border bg-secondary p-4 font-mono text-[11px] leading-relaxed text-foreground">
            {nukeScript}
          </pre>
        </div>
      </div>
    </div>
  );
}
