"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const TYPES = ["character", "prop", "environment", "palette"] as const;

// Client-side so an upload rejected by the action reports why in place rather
// than throwing to the error boundary and losing the operator's file selection.
// The same limits are enforced again server-side in uploadReferenceAsset - this
// is the convenience half, not the guard.
export function UploadReferenceDialog({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(formData: FormData) {
    setError(null);
    setPending(true);
    try {
      await action(formData);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* DialogTrigger renders natively (styled via buttonVariants) instead of
          wrapping a <Button> - nesting two Base UI primitives' render-prop
          cloning produces a real SSR/CSR data-slot hydration mismatch on every
          load. Same reason as app/dashboard/page.tsx. */}
      <DialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
        <Upload className="size-4" />
        Add reference
      </DialogTrigger>
      <DialogContent>
        <form action={submit}>
          <DialogHeader>
            <DialogTitle>Add a reference</DialogTitle>
            <DialogDescription>
              Uploaded references are locked as canon immediately, so the next run
              is held to them. Unlock later to take one out without losing it.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-5 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ref-name">Name</Label>
              <Input
                id="ref-name"
                name="name"
                required
                maxLength={80}
                placeholder="Maya character sheet"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ref-type">Type</Label>
              <select
                id="ref-type"
                name="type"
                required
                defaultValue="character"
                className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ref-image">Image</Label>
              <Input
                id="ref-image"
                name="image"
                type="file"
                required
                accept="image/png,image/jpeg,image/webp"
                className="file:mr-3 file:rounded-sm file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-foreground"
              />
              <p className="font-mono text-[11px] text-muted-foreground">
                PNG, JPEG or WebP · 10MB max
              </p>
            </div>

            {error ? (
              <p
                role="alert"
                className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="mt-6">
            <Button type="submit" disabled={pending}>
              {pending ? "Uploading…" : "Upload and lock"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
