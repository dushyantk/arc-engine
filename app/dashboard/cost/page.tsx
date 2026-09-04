import Link from "next/link";
import { getCostBreakdown } from "@/lib/data";

export const dynamic = "force-dynamic";

function usd(value: number, digits = 2) {
  return `$${value.toFixed(digits)}`;
}

function count(value: number) {
  return value.toLocaleString("en-US");
}

function duration(ms: number) {
  if (ms === 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function agentLabel(name: string) {
  return name.replace(/_/g, " ");
}

function StatTile({
  value,
  label,
  hint,
}: {
  value: string;
  label: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="font-mono text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      {hint ? <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// One hue for magnitude. Identity is carried by the row label, so a categorical
// palette would add nothing - and the semantic tokens are reserved for real
// status, never for "series 4".
function MagnitudeBar({ fraction }: { fraction: number }) {
  const pct = Math.max(fraction * 100, fraction > 0 ? 0.6 : 0);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-sm bg-secondary">
      <div
        className="h-full rounded-sm bg-primary"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default async function CostPage() {
  const { summary, byAgent, byModel } = await getCostBreakdown();

  const generation = byAgent.find((a) => a.agentName === "generation_adapter");
  const generationSpend = generation?.spendUsd ?? 0;
  const supervisionSpend = summary.totalSpendUsd - generationSpend;
  const supervisionShare =
    summary.totalSpendUsd > 0 ? (supervisionSpend / summary.totalSpendUsd) * 100 : 0;

  const maxAgentSpend = Math.max(...byAgent.map((a) => a.spendUsd), 0);
  const maxModelSpend = Math.max(...byModel.map((m) => m.spendUsd), 0);
  const maxP95 = Math.max(...byAgent.map((a) => a.p95Ms), 0);

  const window =
    summary.firstAt && summary.lastAt
      ? `${summary.firstAt.slice(0, 10)} → ${summary.lastAt.slice(0, 10)}`
      : "no runs logged";

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="border-b border-border pb-6">
        <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
          Cost and latency
        </p>
        <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
          Where the money went
        </h1>
        <p className="mt-2 max-w-[68ch] text-sm text-muted-foreground">
          Every figure here is read from{" "}
          <code className="font-mono text-foreground">agent_decision_log</code> at request
          time — the same rows the session log renders one run at a time. Nothing is
          estimated, projected or rounded up.
        </p>
        {/* The page's whole claim is that these numbers are real, so the one way
            they are known to be wrong has to be stated here rather than left for
            someone to discover. */}
        <p className="mt-3 max-w-[68ch] rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-warning">
          Rows written before 2026-09-03 under-report token spend. Every agent counted
          only the tokens in a model&rsquo;s answer, not the thinking tokens billed at the
          same rate — measured at 4.4&times; on one real call. Video is billed per second
          and is unaffected, which is the large majority of the total. The old rows cannot
          be corrected, because the number that went missing was never written down; treat
          anything before that date as a floor, not a figure.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile value={usd(summary.totalSpendUsd)} label="Total spend" hint={window} />
        <StatTile
          value={count(summary.totalCalls)}
          label="Agent calls"
          hint={`across ${count(summary.runs)} runs`}
        />
        <StatTile
          value={count(summary.generations)}
          label="Veo generations"
          hint={generationSpend > 0 ? `${usd(generationSpend)} of the bill` : undefined}
        />
        <StatTile
          value={count(summary.tokensIn + summary.tokensOut)}
          label="Tokens"
          hint={`${count(summary.tokensIn)} in · ${count(summary.tokensOut)} out`}
        />
      </div>

      {/* The one figure that is an argument rather than a metric. */}
      <div className="mt-4 rounded-md border border-border bg-card p-5">
        <p className="font-heading text-sm font-semibold">
          Supervision costs {supervisionShare.toFixed(1)}% of what it protects.
        </p>
        <p className="mt-1.5 max-w-[70ch] text-sm text-muted-foreground">
          Generating the footage is {usd(generationSpend)}. Everything that plans, watches,
          critiques, revises and approves it comes to {usd(supervisionSpend, 2)}. The
          expensive half is the part that is easy; the part that makes a shot belong is
          nearly free.
        </p>
        <div className="mt-4 flex h-2 w-full overflow-hidden rounded-sm bg-secondary">
          <div
            className="h-full bg-primary"
            style={{ width: `${100 - supervisionShare}%` }}
            aria-hidden
          />
          {/* 2px surface gap between adjacent fills, per the chart spec. */}
          <div className="h-full w-[2px] shrink-0 bg-card" aria-hidden />
          <div
            className="h-full bg-primary/35"
            style={{ width: `${supervisionShare}%` }}
            aria-hidden
          />
        </div>
        <div className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>Generation {usd(generationSpend)}</span>
          <span>Supervision {usd(supervisionSpend, 2)}</span>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Spend by agent
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                <th className="pb-2 font-medium">Agent</th>
                <th className="pb-2 font-medium">Share of spend</th>
                <th className="pb-2 text-right font-medium">Spend</th>
                <th className="pb-2 text-right font-medium">Calls</th>
                <th className="pb-2 text-right font-medium">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.map((agent) => (
                <tr key={agent.agentName} className="border-b border-border/60">
                  <td className="py-3 pr-4 font-mono text-[13px] whitespace-nowrap">
                    {agentLabel(agent.agentName)}
                  </td>
                  <td className="w-[38%] py-3 pr-4">
                    <MagnitudeBar
                      fraction={maxAgentSpend > 0 ? agent.spendUsd / maxAgentSpend : 0}
                    />
                  </td>
                  <td className="py-3 pl-4 text-right font-mono tabular-nums">
                    {agent.spendUsd === 0 ? (
                      <span className="text-muted-foreground">$0.00</span>
                    ) : (
                      usd(agent.spendUsd, 4)
                    )}
                  </td>
                  <td className="py-3 pl-4 text-right font-mono text-muted-foreground tabular-nums">
                    {count(agent.calls)}
                  </td>
                  <td className="py-3 pl-4 text-right font-mono text-muted-foreground tabular-nums">
                    {count(agent.tokensIn + agent.tokensOut)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          The approval gate costs nothing and takes no time because it is deterministic —
          it makes no model call at all, which is the point of it being a gate rather than
          another judgement.
        </p>
      </section>

      {/* Latency is a different measure from cost, so it gets its own chart rather
          than a second axis on the one above. */}
      <section className="mt-10">
        <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Latency by agent
        </h2>
        <p className="mt-1 max-w-[68ch] text-xs text-muted-foreground">
          Bar runs to the 95th percentile; the notch marks the median. A run is slow
          because it is watching video, not because it is waiting on a queue.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {byAgent
            .filter((agent) => agent.maxMs > 0)
            .map((agent) => {
              const p95Fraction = maxP95 > 0 ? agent.p95Ms / maxP95 : 0;
              const p50Offset = agent.p95Ms > 0 ? (agent.p50Ms / maxP95) * 100 : 0;
              return (
                <div key={agent.agentName}>
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="font-mono text-[13px]">{agentLabel(agent.agentName)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      p50 {duration(agent.p50Ms)} · p95 {duration(agent.p95Ms)}
                    </span>
                  </div>
                  <div className="relative mt-1.5 h-2 w-full overflow-hidden rounded-sm bg-secondary">
                    <div
                      className="h-full rounded-sm bg-primary/55"
                      style={{ width: `${p95Fraction * 100}%` }}
                    />
                    <span
                      className="absolute top-0 h-full w-[2px] bg-primary"
                      style={{ left: `${p50Offset}%` }}
                      aria-hidden
                    />
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-heading text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Spend by model
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                <th className="pb-2 font-medium">Model</th>
                <th className="pb-2 font-medium">Share of spend</th>
                <th className="pb-2 text-right font-medium">Spend</th>
                <th className="pb-2 text-right font-medium">Calls</th>
                <th className="pb-2 text-right font-medium">Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((model) => (
                <tr key={model.model} className="border-b border-border/60">
                  <td className="py-3 pr-4 font-mono text-[13px] whitespace-nowrap">
                    {model.model}
                  </td>
                  <td className="w-[38%] py-3 pr-4">
                    <MagnitudeBar
                      fraction={maxModelSpend > 0 ? model.spendUsd / maxModelSpend : 0}
                    />
                  </td>
                  <td className="py-3 pl-4 text-right font-mono tabular-nums">
                    {model.spendUsd === 0 ? (
                      <span className="text-muted-foreground">$0.00</span>
                    ) : (
                      usd(model.spendUsd, 4)
                    )}
                  </td>
                  <td className="py-3 pl-4 text-right font-mono text-muted-foreground tabular-nums">
                    {count(model.calls)}
                  </td>
                  <td className="py-3 pl-4 text-right font-mono text-muted-foreground tabular-nums">
                    {duration(model.avgMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-8 text-sm text-muted-foreground">
        Per-run detail, step by step, is in the{" "}
        <Link href="/dashboard/sessions" className="text-primary hover:underline">
          session log
        </Link>
        .
      </p>
    </div>
  );
}
