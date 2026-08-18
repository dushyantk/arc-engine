import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  AlertTriangle,
  XCircle,
  Film,
  ClipboardCheck,
  Eye,
  RefreshCw,
  Pencil,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const CTA_LABEL = "See the pipeline";

const DEFECT_CATEGORIES = [
  "Character identity",
  "Costume continuity",
  "Hero prop",
  "Screen direction",
  "Environment continuity",
  "Temporal stability",
];

const PIPELINE_STAGES = [
  {
    icon: Pencil,
    name: "Plan",
    body: "Gemini queries the approved continuity state through ClickHouse before it writes a single word of the prompt.",
  },
  {
    icon: Film,
    name: "Generate",
    body: "Veo 3.1 renders the candidate shot from that grounded prompt.",
  },
  {
    icon: Eye,
    name: "Watch",
    body: "The critic reviews labeled frames in order, not just the first and last one.",
  },
  {
    icon: ClipboardCheck,
    name: "Critique",
    body: "Every finding is pass, warning, or fail. Creative variation is not the same thing as a defect.",
  },
  {
    icon: RefreshCw,
    name: "Revise",
    body: "A failed finding becomes a concrete regeneration instruction, not a vague retry.",
  },
  {
    icon: Check,
    name: "Approve",
    body: "Only when every hard failure clears. Warnings are logged, never hidden.",
  },
];

const REAL_FINDINGS = [
  {
    verdict: "fail" as const,
    text: "Suitcase changed red to brown. Station clock face changed time.",
    source: "SH020 v001",
  },
  {
    verdict: "fail" as const,
    text: "The suitcase teleports between hands exactly between Frame 4 and Frame 5.",
    source: "SH020 v003, frame comparison",
  },
  {
    verdict: "fail" as const,
    text: "The prompt explicitly required excluding the station clock. A prominent clock is visible throughout.",
    source: "SH020 v006",
  },
];

const STATS = [
  { value: "6", label: "versions generated for one shot" },
  { value: "4", label: "real Veo 3.1 generations" },
  { value: "$13.23", label: "spent finding out what breaks" },
  { value: "55", label: "agent calls logged, cost and all" },
];

function VerdictIcon({ verdict }: { verdict: "pass" | "warning" | "fail" }) {
  if (verdict === "pass") return <Check className="size-3.5" />;
  if (verdict === "warning") return <AlertTriangle className="size-3.5" />;
  return <XCircle className="size-3.5" />;
}

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Film className="size-[18px] text-primary" />
            DAILIES
          </span>
          <nav className="flex items-center gap-6">
            <Link
              href="#problem"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              Product
            </Link>
            <Link
              href="#how-it-works"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              How it works
            </Link>
            <Link
              href="/dashboard"
              className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              Demo
            </Link>
            <Button
              render={<Link href="/dashboard">{CTA_LABEL}</Link>}
              nativeButton={false}
              size="sm"
            />
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero: asymmetric split, real footage on the right */}
        <section className="mx-auto max-w-7xl px-6 pt-16 pb-20 sm:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <div>
              <h1 className="font-heading max-w-[15ch] text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                Continuity is the hard problem. We built the supervisor for
                it.
              </h1>
              <p className="mt-5 max-w-[42ch] text-base text-muted-foreground">
                Every generated shot is checked against approved references,
                neighboring shots, and your show&apos;s own technical rules
                before it ships.
              </p>
              <div className="mt-8">
                <Button
                  render={
                    <Link href="/dashboard">
                      {CTA_LABEL}
                      <ArrowRight className="size-4" />
                    </Link>
                  }
                  nativeButton={false}
                  size="lg"
                />
              </div>
            </div>

            <div>
              <Link
                href="/dashboard/SH020"
                className="group relative block aspect-[16/10] overflow-hidden rounded-lg border border-border"
              >
                <Image
                  src="/proof/hero.jpg"
                  alt="A generated frame from SH020, Dailies' own test sequence: a woman crossing a rain-soaked station platform holding a red suitcase"
                  fill
                  sizes="(min-width: 1024px) 45vw, 100vw"
                  priority
                  className="object-cover"
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-[0.08]"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 3px)",
                  }}
                />
                <div className="absolute inset-0 m-auto flex size-11 items-center justify-center rounded-full border border-white/25 bg-black/40 transition-colors group-hover:bg-black/55">
                  <Play className="size-4 translate-x-px text-white" />
                </div>
                <span className="absolute bottom-3 left-3 rounded bg-black/50 px-2 py-0.5 font-mono text-[10.5px] text-white/80">
                  SH020_v006.mp4
                </span>
              </Link>
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                Real footage, generated by Dailies. Click to watch it fail,
                then watch it get fixed.
              </p>
            </div>
          </div>
        </section>

        {/* Problem framing: full-width statement, real defect categories */}
        <section id="problem" className="scroll-mt-16 border-t border-border bg-card/40">
          <div className="mx-auto max-w-7xl px-6 py-16">
            <h2 className="font-heading max-w-[24ch] text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Generating a shot is easy. Making it belong in the movie is the
              problem.
            </h2>
            <p className="mt-4 max-w-[60ch] text-base text-muted-foreground">
              A coat changes color between takes. A prop jumps hands. The
              clock in the background tells a different time in every shot.
              Small breaks, and the illusion is gone. This is what Dailies
              checks on every version, for real.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {DEFECT_CATEGORIES.map((category) => (
                <Badge key={category} variant="outline">
                  {category}
                </Badge>
              ))}
            </div>
          </div>
        </section>

        {/* How it works: 6-cell grid, the real agent pipeline */}
        <section id="how-it-works" className="scroll-mt-16 border-t border-border">
          <div className="mx-auto max-w-7xl px-6 py-16">
            <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              A closed loop, not a slot machine.
            </h2>
            <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {PIPELINE_STAGES.map((stage) => (
                <div key={stage.name}>
                  <div className="flex items-center gap-2.5">
                    <stage.icon className="size-4 text-primary" />
                    <span className="font-mono text-sm font-semibold">
                      {stage.name}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {stage.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Real evidence: actual critic findings from this session */}
        <section className="border-t border-border bg-card/40">
          <div className="mx-auto max-w-7xl px-6 py-16">
            <div className="grid gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16">
              <div>
                <div className="overflow-hidden rounded-lg border border-border">
                  <Image
                    src="/proof/evidence-clock.jpg"
                    alt="A generated frame from an earlier SH020 attempt, with the background station clock clearly visible despite the generation prompt asking to exclude it"
                    width={1280}
                    height={720}
                    className="h-auto w-full"
                  />
                </div>
                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  SH020 v003. The clock was supposed to be out of frame.
                </p>
              </div>

              <div>
                <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                  This is a real run, not a mockup.
                </h2>
                <p className="mt-3 max-w-[55ch] text-sm text-muted-foreground">
                  Every finding below is quoted verbatim from Dailies&apos;
                  own critic, reviewing its own footage.
                </p>

                <ul className="mt-6 flex flex-col gap-3">
                  {REAL_FINDINGS.map((finding) => (
                    <li
                      key={finding.text}
                      className="rounded-lg border border-border bg-card p-4"
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 text-destructive">
                          <VerdictIcon verdict={finding.verdict} />
                        </span>
                        <p className="text-sm">{finding.text}</p>
                      </div>
                      <p className="mt-2 pl-6 font-mono text-xs text-muted-foreground">
                        {finding.source}
                      </p>
                    </li>
                  ))}
                </ul>

                <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
                  {STATS.map((stat) => (
                    <div key={stat.label}>
                      <dt className="sr-only">{stat.label}</dt>
                      <dd className="font-mono text-2xl font-semibold text-foreground">
                        {stat.value}
                      </dd>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {stat.label}
                      </p>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-7xl px-6 py-20 text-center">
            <h2 className="font-heading mx-auto max-w-[20ch] text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Watch the pipeline work on a sequence it hasn&apos;t solved yet.
            </h2>
            <div className="mt-8 flex justify-center">
              <Button
                render={
                  <Link href="/dashboard">
                    {CTA_LABEL}
                    <ArrowRight className="size-4" />
                  </Link>
                }
                nativeButton={false}
                size="lg"
              />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <p className="font-mono text-sm font-semibold">DAILIES</p>
          <p className="mt-1 text-sm text-muted-foreground">
            An agentic GenFX supervisor that makes an AI-generated sequence
            survive dailies.
          </p>
        </div>
      </footer>
    </div>
  );
}
