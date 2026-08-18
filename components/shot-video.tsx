"use client";

import { useEffect, useRef, useState } from "react";
import { Film } from "lucide-react";

export function ShotVideo({ src, label }: { src: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    // The server-rendered <video> can start loading, and fail, before this
    // effect attaches a listener - so check for an error that already
    // happened as well as listening for one that hasn't yet.
    if (el.error) {
      setFailed(true);
      return;
    }
    const handleError = () => setFailed(true);
    el.addEventListener("error", handleError);
    return () => el.removeEventListener("error", handleError);
  }, []);

  if (failed) {
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-border bg-secondary text-muted-foreground">
        <Film className="size-5" />
        <span className="font-mono text-[11px] uppercase tracking-wide">
          No footage stored for this version
        </span>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      preload="metadata"
      aria-label={label}
      className="aspect-video w-full rounded-lg border border-border bg-secondary"
    />
  );
}
