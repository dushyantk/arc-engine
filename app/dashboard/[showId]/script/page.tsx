import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check, PenLine, X } from "lucide-react";
import { getScripts, getShowDetail } from "@/lib/data";
import { draftScript, submitScriptApproval } from "@/lib/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const dynamic = "force-dynamic";

const STATUS_VARIANT = {
  approved: "default",
  draft: "outline",
  superseded: "outline",
} as const;

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default async function ScriptPage({
  params,
}: {
  params: Promise<{ showId: string }>;
}) {
  const { showId } = await params;
  const [detail, scripts] = await Promise.all([getShowDetail(showId), getScripts(showId)]);
  if (!detail) notFound();

  const { show } = detail;
  const draftForShow = draftScript.bind(null, showId);
  const approved = scripts.find((s) => s.status === "approved") ?? null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <Link
        href={`/dashboard/${showId}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {show.name}
      </Link>

      <div className="mt-4 border-b border-border pb-6">
        <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
          Script
        </p>
        <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
          What this show is
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          Describe the idea and the story agent writes a short, shootable sequence from
          it. Writing is cheap and ungated — a fraction of a cent, text only. Approving is
          the gate, because the shot list and every generation after it are planned from
          whichever script is approved.
        </p>
      </div>

      {/* Author */}
      <form action={draftForShow} className="mt-8">
        <label
          htmlFor="idea"
          className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase"
        >
          The idea, in your words
        </label>
        <Textarea
          id="idea"
          name="idea"
          required
          rows={3}
          maxLength={4000}
          placeholder="A lighthouse keeper realises the beam is answering something in the water."
          className="mt-2"
        />
        <div className="mt-2 flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            Each pass is a new version. Nothing is overwritten, so the script a breakdown
            was made from stays readable.
          </p>
          <Button type="submit">
            <PenLine className="size-4" />
            Write a draft
          </Button>
        </div>
      </form>

      {/* Versions */}
      <div className="mt-10 flex flex-col gap-5">
        {scripts.map((script) => {
          const approveAction = submitScriptApproval.bind(null, showId, script.id);
          const isOpen = script.status === "draft";
          return (
            <article
              key={script.id}
              className={`rounded-md border bg-card ${
                script.status === "approved" ? "border-success/40" : "border-border"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-medium">v{script.versionNumber}</span>
                  <Badge variant={STATUS_VARIANT[script.status]}>
                    {script.status === "approved" ? (
                      <Check className="size-3" />
                    ) : null}
                    {script.status}
                  </Badge>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {formatDate(script.createdAt)}
                </span>
              </div>

              <div className="px-4 py-4">
                <p className="text-sm font-medium">{script.logline}</p>
                <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
                  {script.synopsis}
                </p>

                <p className="mt-4 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                  Written from
                </p>
                <p className="mt-1 max-w-[70ch] border-l-2 border-border pl-3 text-xs text-muted-foreground italic">
                  {script.sourcePrompt}
                </p>

                <details className="mt-4">
                  <summary className="cursor-pointer font-mono text-[11px] tracking-wide text-muted-foreground uppercase hover:text-foreground">
                    Full script
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-sm border border-border bg-background p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {script.body}
                  </pre>
                </details>

                {script.decisions.length > 0 ? (
                  <div className="mt-4 flex flex-col gap-1.5">
                    {script.decisions.map((decision, index) => (
                      <p
                        key={index}
                        className="font-mono text-[11px] text-muted-foreground"
                      >
                        <span
                          className={
                            decision.decision === "approved"
                              ? "text-success"
                              : "text-destructive"
                          }
                        >
                          {decision.decision.toUpperCase()}
                        </span>{" "}
                        · {decision.actor} · {formatDate(decision.createdAt)}
                        {decision.reason ? ` — ${decision.reason}` : ""}
                      </p>
                    ))}
                  </div>
                ) : null}

                {isOpen ? (
                  <form action={approveAction} className="mt-5 border-t border-border pt-4">
                    <label
                      htmlFor={`reason-${script.id}`}
                      className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase"
                    >
                      Reason (required to reject)
                    </label>
                    <Textarea
                      id={`reason-${script.id}`}
                      name="reason"
                      rows={2}
                      maxLength={2000}
                      placeholder="Why this script is or isn't what the show should be planned from."
                      className="mt-2"
                    />
                    <div className="mt-3 flex gap-2">
                      <Button type="submit" name="decision" value="approved">
                        <Check className="size-4" />
                        Approve — plan from this
                      </Button>
                      <Button
                        type="submit"
                        name="decision"
                        value="rejected"
                        variant="outline"
                      >
                        <X className="size-4" />
                        Reject
                      </Button>
                    </div>
                    {approved ? (
                      <p className="mt-2 font-mono text-[11px] text-warning">
                        Approving this supersedes v{approved.versionNumber}, which is
                        approved now — one script per show is planned from at a time.
                      </p>
                    ) : null}
                  </form>
                ) : null}
              </div>
            </article>
          );
        })}

        {scripts.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No script yet. Describe the idea above and the story agent writes one.
          </p>
        ) : null}
      </div>
    </div>
  );
}
