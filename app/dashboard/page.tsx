import Link from "next/link";
import { Film, Plus } from "lucide-react";
import { getShows } from "@/lib/data";
import { createShow } from "@/lib/actions";
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

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const rows = await getShows();

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            Dailies
          </p>
          <h1 className="font-heading mt-1 text-2xl font-semibold tracking-tight">
            Shows
          </h1>
        </div>
        <Dialog>
          {/* DialogTrigger renders natively (styled via buttonVariants)
              instead of wrapping a <Button> - nesting two Base UI
              primitives' render-prop cloning produces a real SSR/CSR
              data-slot hydration mismatch on every load. */}
          <DialogTrigger className={buttonVariants({ size: "sm" })}>
            <Plus className="size-4" />
            New show
          </DialogTrigger>
          <DialogContent>
            <form action={createShow}>
              <DialogHeader>
                <DialogTitle>New show</DialogTitle>
                <DialogDescription>
                  The top of the hierarchy — sequences and shots live
                  underneath it.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  placeholder="Platform Chase"
                  required
                  autoFocus
                  className="mt-1.5"
                />
              </div>
              <DialogFooter>
                <Button type="submit">Create show</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-8 flex flex-col gap-2">
        {rows.map(({ show, sequenceCount, shotCount }) => (
          <Link
            key={show.id}
            href={`/dashboard/${show.id}`}
            className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-ring"
          >
            <div className="flex items-center gap-3">
              <Film className="size-4 text-primary" />
              <div>
                <p className="text-sm font-medium">{show.name}</p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {sequenceCount} sequence{sequenceCount === 1 ? "" : "s"}{" "}
                  &middot; {shotCount} shot{shotCount === 1 ? "" : "s"}
                </p>
              </div>
            </div>
          </Link>
        ))}
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No shows yet. Create one to get started.
          </p>
        ) : null}
      </div>
    </div>
  );
}
