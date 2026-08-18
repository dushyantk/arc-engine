"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <AlertTriangle className="size-6 text-destructive" />
      <h1 className="font-heading mt-4 text-xl font-semibold tracking-tight">
        Something broke talking to the stack.
      </h1>
      <p className="mt-2 max-w-[50ch] text-sm text-muted-foreground">
        Postgres, ClickHouse, or MinIO didn&apos;t respond the way this page
        expected.{" "}
        {error.digest ? (
          <span className="font-mono text-xs">Ref: {error.digest}</span>
        ) : null}
      </p>
      <Button onClick={() => reset()} size="sm" className="mt-6">
        Try again
      </Button>
    </div>
  );
}
