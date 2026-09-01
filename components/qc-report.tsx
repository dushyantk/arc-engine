import { AlertTriangle, Check, Minus, X } from "lucide-react";
import type { QcFinding } from "@/lib/data";

const VERDICT_STYLE: Record<QcFinding["verdict"], string> = {
  pass: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  fail: "bg-destructive/15 text-destructive",
  // Deliberately the desaturated token, not success: an axis that could not be
  // observed is not a passing axis, and must not read like one at a glance.
  not_applicable: "bg-info/15 text-info",
};

// Only a declined axis is spelled out. Colour plus icon already carries
// pass/warning/fail, and stamping "PASS" on every chip would be noise - but a
// desaturated category name with a dash does not say "this was not looked at",
// which is precisely what has to land.
const NOT_CHECKED_SUFFIX = " · not checked";

function VerdictIcon({ verdict }: { verdict: QcFinding["verdict"] }) {
  if (verdict === "pass") return <Check className="size-[10px]" />;
  if (verdict === "warning") return <AlertTriangle className="size-[10px]" />;
  if (verdict === "not_applicable") return <Minus className="size-[10px]" />;
  return <X className="size-[10px]" />;
}

export function QcReport({ findings }: { findings: QcFinding[] }) {
  // A band on this timeline means "something happened in these frames". An axis
  // that could not be observed is excluded even if the critic attached a range
  // to it, because otherwise a not-checked axis paints as a defect.
  const flagged = findings.filter(
    (f) =>
      f.verdict !== "not_applicable" &&
      f.frameRangeStart !== null &&
      f.frameRangeEnd !== null,
  ) as (QcFinding & { frameRangeStart: number; frameRangeEnd: number })[];

  // Scaled to the flagged findings' own span, not a fixed frame count -
  // frame_range_start/end are raw encoded-frame numbers, not indices into
  // the critic's 12 labeled review stills, so there's no shared total to
  // anchor a fixed-cell grid to without fabricating one.
  const domainEnd = Math.max(1, ...flagged.map((f) => f.frameRangeEnd)) * 1.08;

  return (
    <div className="rounded-md border border-border bg-secondary/40 p-4">
      <p className="mb-3 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        QC report
      </p>

      {flagged.length > 0 ? (
        <div className="relative mb-4 h-6 overflow-hidden rounded-sm border border-border bg-background">
          {flagged.map((f, i) => (
            <div
              key={`${f.category}-${i}`}
              title={`${f.category.replace(/_/g, " ")}: frames ${f.frameRangeStart}-${f.frameRangeEnd}`}
              className={`absolute inset-y-0 ${f.verdict === "fail" ? "bg-destructive/40" : "bg-warning/40"}`}
              style={{
                left: `${(f.frameRangeStart / domainEnd) * 100}%`,
                width: `${((f.frameRangeEnd - f.frameRangeStart) / domainEnd) * 100}%`,
              }}
            />
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {findings.map((finding, i) => (
          <span
            key={`${finding.category}-${i}`}
            title={finding.description}
            className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[10.5px] font-semibold tracking-wide uppercase ${VERDICT_STYLE[finding.verdict]}`}
          >
            <VerdictIcon verdict={finding.verdict} />
            {finding.category.replace(/_/g, " ")}
            {finding.verdict === "not_applicable" ? NOT_CHECKED_SUFFIX : ""}
            {finding.frameRangeStart !== null
              ? ` · F${finding.frameRangeStart}-${finding.frameRangeEnd}`
              : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
