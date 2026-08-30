import Link from "next/link";
import { FileVideo, ImageIcon } from "lucide-react";
import { getLedger, listBuildArtifacts } from "@/lib/ledger";
import { getCostBreakdown } from "@/lib/data";

export const dynamic = "force-dynamic";

function bytesLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export default async function LedgerPage() {
  const [ledger, artifacts, costs] = await Promise.all([
    getLedger(),
    listBuildArtifacts(),
    getCostBreakdown(),
  ]);

  if (!ledger) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Build ledger
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing published yet. The ledger and its footage live in{" "}
          <code className="font-mono text-foreground">generations/</code>, which is
          gitignored on purpose — real generated video does not belong in git history — so
          they are served from object storage instead.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          From the machine that produced the footage, run{" "}
          <code className="font-mono text-foreground">pnpm ledger:sync</code> to publish it.
        </p>
      </div>
    );
  }

  const totalBytes = artifacts.reduce(
    (sum, group) => sum + group.files.reduce((n, f) => n + f.bytes, 0),
    0,
  );
  const fileCount = artifacts.reduce((sum, group) => sum + group.files.length, 0);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <div className="border-b border-border pb-6">
        <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
          Build record
        </p>
        <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
          How this was actually built
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          The working log kept while building this system: every real generation, the
          defects found in them, the ones that turned out to be the critic&apos;s mistake
          rather than the footage&apos;s, and what each step cost. Written as the work
          happened, not reconstructed afterwards.
        </p>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs text-muted-foreground tabular-nums">
          <span>{ledger.episodeCount} entries</span>
          <span>{costs.summary.generations} real generations</span>
          <span>${costs.summary.totalSpendUsd.toFixed(2)} spent</span>
          <span>
            {fileCount} artefacts preserved ({bytesLabel(totalBytes)})
          </span>
          {ledger.syncedAt ? (
            <span>published {ledger.syncedAt.slice(0, 10)}</span>
          ) : null}
        </div>
      </div>

      {/* Contents: 31 entries is too many to scroll blind. */}
      <nav className="mt-8 rounded-md border border-border bg-card p-4">
        <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
          Contents
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {ledger.phases.map((phase) => (
            <div key={phase.title}>
              <p className="font-mono text-[12px] font-medium">{phase.title}</p>
              {phase.episodes.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {phase.episodes.map((episode) => (
                    <li key={episode.title}>
                      <a
                        href={`#entry-${episode.number ?? episode.title}`}
                        className="font-mono text-[11px] text-muted-foreground hover:text-primary"
                      >
                        {episode.number !== null ? `${episode.number}.` : "—"}{" "}
                        {episode.title}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      </nav>

      {ledger.phases.map((phase) => (
        <section key={phase.title} className="mt-12">
          <h2 className="font-heading border-b border-border pb-2 text-lg font-semibold tracking-tight">
            {phase.title}
          </h2>

          {phase.intro ? (
            <div
              className="ledger-prose mt-4"
              dangerouslySetInnerHTML={{ __html: phase.intro }}
            />
          ) : null}

          {phase.episodes.map((episode) => (
            <article
              key={episode.title}
              id={`entry-${episode.number ?? episode.title}`}
              className="mt-8 scroll-mt-6"
            >
              <h3 className="font-heading text-sm font-semibold">
                {episode.number !== null ? (
                  <span className="mr-2 text-muted-foreground tabular-nums">
                    {String(episode.number).padStart(2, "0")}
                  </span>
                ) : null}
                {episode.title}
              </h3>

              <div
                className="ledger-prose mt-3"
                dangerouslySetInnerHTML={{ __html: episode.html }}
              />

              {episode.media.length > 0 ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {episode.media.map((item) =>
                    item.kind === "video" ? (
                      <figure key={item.key}>
                        {/* No poster attribute: the build artefacts are the raw
                            clips, with no companion stills, so pointing at a
                            derived .jpg only 404s. preload="metadata" lets the
                            browser show its own first frame instead. */}
                        <video
                          src={item.url}
                          controls
                          preload="metadata"
                          className="w-full rounded-sm border border-border bg-secondary"
                        />
                        <figcaption className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {item.key}
                        </figcaption>
                      </figure>
                    ) : (
                      <figure key={item.key}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.url}
                          alt={item.key}
                          loading="lazy"
                          className="w-full rounded-sm border border-border bg-secondary"
                        />
                        <figcaption className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {item.key}
                        </figcaption>
                      </figure>
                    ),
                  )}
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ))}

      <section className="mt-14">
        <h2 className="font-heading border-b border-border pb-2 text-lg font-semibold tracking-tight">
          Preserved artefacts
        </h2>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          Everything the run produced and kept, served from object storage. The narrative
          above cites whole folders more often than single files, so this is the full
          inventory rather than only what happened to be named inline.
        </p>

        <div className="mt-5 flex flex-col gap-5">
          {artifacts.map((group) => (
            <div key={group.path}>
              <p className="font-mono text-[12px] text-muted-foreground">{group.path}/</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {group.files.map((file) => (
                  <a
                    key={file.key}
                    href={file.url}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground hover:border-ring hover:text-foreground"
                  >
                    {file.kind === "video" ? (
                      <FileVideo className="size-3" />
                    ) : (
                      <ImageIcon className="size-3" />
                    )}
                    {file.name}
                    <span className="text-muted-foreground/60">{bytesLabel(file.bytes)}</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
          {artifacts.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No artefacts published. Run <code className="font-mono">pnpm ledger:sync</code>.
            </p>
          ) : null}
        </div>
      </section>

      <p className="mt-10 text-sm text-muted-foreground">
        Per-run cost and latency for these same steps is on the{" "}
        <Link href="/dashboard/cost" className="text-primary hover:underline">
          cost page
        </Link>
        .
      </p>
    </div>
  );
}
