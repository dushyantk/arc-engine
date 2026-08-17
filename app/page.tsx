export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="rounded-sm bg-secondary px-2.5 py-1 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        pre-beta
      </span>
      <h1 className="font-mono text-2xl font-semibold tracking-tight text-foreground">
        Dailies
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        An agentic GenFX supervisor that makes an AI-generated sequence survive dailies.
      </p>
    </main>
  );
}
