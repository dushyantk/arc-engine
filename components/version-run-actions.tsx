"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function VersionRunActions({
  shotCode,
  showName,
  versionNumber,
}: {
  shotCode: string;
  showName: string;
  versionNumber: number;
}) {
  const router = useRouter();
  const [recritiquing, setRecritiquing] = useState(false);
  const [reusing, setReusing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startRun(path: string, body: object, setPending: (v: boolean) => void) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(path, { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ?? "Failed to start.");
        setPending(false);
        return;
      }
      router.push(`/dashboard/sessions/${data.run_id}`);
    } catch {
      setError("Could not reach the agent runtime.");
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        variant="outline"
        size="sm"
        disabled={recritiquing}
        onClick={() =>
          startRun(
            "/api/runs/recritique",
            { shot_code: shotCode, version_number: versionNumber, show_name: showName },
            setRecritiquing,
          )
        }
      >
        {recritiquing ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Eye className="size-3.5" />
        )}
        Recritique
      </Button>

      <Dialog>
        <DialogTrigger
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          <RefreshCw className="size-3.5" />
          Reuse prompt
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reuse v{versionNumber}&apos;s exact prompt</DialogTitle>
            <DialogDescription>
              Generates a genuinely new version with v{versionNumber}&apos;s
              exact prompt and settings — no new planning call. Isolates
              whether a defect is systematic or just run-to-run
              stochasticity. Still a real, billed Veo call.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={reusing}
              onClick={() =>
                startRun(
                  "/api/runs/reuse-prompt",
                  {
                    shot_code: shotCode,
                    source_version: versionNumber,
                    show_name: showName,
                    confirm_cost: true,
                  },
                  setReusing,
                )
              }
            >
              {reusing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Starting…
                </>
              ) : (
                "Start real generation"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
