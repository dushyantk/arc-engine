import Link from "next/link";
import { Film } from "lucide-react";

export default function DashboardNotFound() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-24 text-center">
      <Film className="size-6 text-muted-foreground" />
      <h1 className="font-heading mt-4 text-xl font-semibold tracking-tight">
        No shot by that code.
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        It isn&apos;t in this sequence, or it hasn&apos;t been seeded yet.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 text-sm text-primary hover:underline"
      >
        Back to the sequence &rarr;
      </Link>
    </div>
  );
}
