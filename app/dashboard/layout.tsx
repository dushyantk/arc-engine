import Link from "next/link";
import { Film } from "lucide-react";
import { getGlobalRailStats } from "@/lib/data";

function RailItem({
  label,
  count,
  href,
}: {
  label: string;
  count?: number;
  href?: string;
}) {
  const inner = (
    <>
      <span>{label}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground/70">{count}</span>
      ) : null}
    </>
  );
  const className =
    "flex items-center justify-between rounded-sm px-2.5 py-1.5 font-mono text-[11.5px] tracking-wide";

  if (!href) {
    return (
      <span className={`${className} text-muted-foreground/50`}>
        {inner}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={`${className} bg-secondary font-medium text-foreground hover:bg-secondary/80`}
    >
      {inner}
    </Link>
  );
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const stats = await getGlobalRailStats();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="flex h-14 items-center px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight"
          >
            <Film className="size-[15px] text-primary" />
            DAILIES
          </Link>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="hidden w-[220px] shrink-0 border-r border-border px-4 py-6 md:block">
          <div className="mb-5 flex items-center gap-2 px-2.5">
            <Film className="size-[15px] text-primary" />
            <span className="font-mono text-[13px] font-semibold">
              DAILIES
            </span>
          </div>
          <nav className="flex flex-col gap-0.5">
            <RailItem label="SHOWS" count={stats.showCount} href="/dashboard" />
            <RailItem
              label="SESSION_LOG"
              count={stats.sessionLogCount}
              href="/dashboard/sessions"
            />
            <RailItem label="COST" href="/dashboard/cost" />
            <RailItem label="LEDGER" href="/dashboard/ledger" />
            <RailItem label="EXPORT" href="/dashboard/export" />
          </nav>
        </aside>

        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
