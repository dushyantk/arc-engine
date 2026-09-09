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
    </main>
  );
}
