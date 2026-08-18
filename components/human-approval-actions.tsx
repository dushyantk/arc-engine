"use client";

import { useState } from "react";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type SubmitAction = (formData: FormData) => Promise<void>;

export function HumanApprovalActions({
  versionLabel,
  submitAction,
}: {
  versionLabel: string;
  submitAction: SubmitAction;
}) {
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [reason, setReason] = useState("");
  const reasonMissing = decision === "rejected" && reason.trim().length === 0;

  return (
    <Dialog>
      <DialogTrigger className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium transition-colors hover:bg-muted">
        <UserCheck className="size-3.5" />
        Human review
      </DialogTrigger>
      <DialogContent>
        <form action={submitAction}>
          <DialogHeader>
            <DialogTitle>Human review — {versionLabel}</DialogTitle>
            <DialogDescription>
              Records a real decision with your reasoning, actor=human —
              this can override the agent&apos;s own call too, not just
              resolve a needs_human state.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 flex flex-col gap-3">
            <div className="flex gap-2">
              <label
                className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-center text-sm ${
                  decision === "approved"
                    ? "border-success bg-success/10 text-success"
                    : "border-border text-muted-foreground"
                }`}
              >
                <input
                  type="radio"
                  name="decision"
                  value="approved"
                  checked={decision === "approved"}
                  onChange={() => setDecision("approved")}
                  className="sr-only"
                />
                Approve
              </label>
              <label
                className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-center text-sm ${
                  decision === "rejected"
                    ? "border-destructive bg-destructive/10 text-destructive"
                    : "border-border text-muted-foreground"
                }`}
              >
                <input
                  type="radio"
                  name="decision"
                  value="rejected"
                  checked={decision === "rejected"}
                  onChange={() => setDecision("rejected")}
                  className="sr-only"
                />
                Reject
              </label>
            </div>

            <div>
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  decision === "rejected"
                    ? "Required — what's wrong, so the next attempt can address it."
                    : "Optional — why this holds up."
                }
                rows={3}
                className="font-mono text-sm"
              />
              {reasonMissing ? (
                <p className="mt-1 text-xs text-destructive">
                  A reason is required when rejecting.
                </p>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={reasonMissing}>
              Submit decision
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
