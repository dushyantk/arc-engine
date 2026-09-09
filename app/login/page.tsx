import { Suspense } from "react";
import { Film } from "lucide-react";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="flex items-center gap-2">
        <Film className="size-[15px] text-primary" />
        <span className="font-mono text-[13px] font-semibold">ARC ENGINE</span>
      </div>
      <h1 className="font-heading mt-6 text-xl font-semibold tracking-tight">
        Sign in
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This instance can spend real money on generation, so the dashboard is not
        public. There is no sign-up: accounts are created deliberately, on the server.
      </p>
      <Suspense>
        <LoginForm />
      </Suspense>

      {/* Published deliberately. The account is read-only - it can open every
          page and change nothing - because this instance makes real, billed
          generation calls and holds a real approval record. See
          lib/auth-guards.ts, which is what makes that true rather than a
          promise. */}
      <div className="mt-8 rounded-md border border-border bg-card px-4 py-3">
        <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
          Demo access
        </p>
        <p className="mt-2 font-mono text-[12.5px] leading-relaxed text-foreground">
          demo@arc-engine.dev
          <br />
          watch-the-record-2026
        </p>
        <p className="mt-2 max-w-[46ch] text-xs leading-relaxed text-muted-foreground">
          Read-only: every page, every run, every cost and every verdict is
          visible, and nothing can be changed or generated. Generation spends
          real money, so that button is not on offer here.
        </p>
      </div>
    </main>
  );
}
