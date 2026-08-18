function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-sm bg-secondary ${className}`}
    />
  );
}

export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      <div className="flex items-end justify-between gap-4 border-b border-border pb-6">
        <div className="flex flex-col gap-2">
          <Bar className="h-3 w-24" />
          <Bar className="h-7 w-40" />
        </div>
        <Bar className="h-4 w-28" />
      </div>

      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <Bar className="aspect-video w-full rounded-none" />
            <div className="flex items-center justify-between p-4">
              <div className="flex flex-col gap-2">
                <Bar className="h-3.5 w-16" />
                <Bar className="h-3 w-20" />
              </div>
              <Bar className="h-5 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
