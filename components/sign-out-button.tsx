"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "@/lib/auth-client";

/** Signing out goes through Better Auth's own handler, never a bare redirect:
 *  it clears the cookie unconditionally, including when the session row has
 *  already gone, which is the case a hand-rolled redirect gets wrong. */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await signOut();
        // refresh() so the layout re-runs its check rather than serving a
        // cached signed-in shell.
        router.push("/login");
        router.refresh();
      }}
      className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
    >
      <LogOut className="size-3" />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
