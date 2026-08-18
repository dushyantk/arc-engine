"use client";

import { useEffect, useRef, useState } from "react";
import { Film } from "lucide-react";

export function ShotVideo({
  src,
  label,
  autoPlay = false,
  muted = false,
  onEnded,
  onError,
  fallbackLabel = "No footage stored for this version",
  className = "aspect-video w-full rounded-lg border border-border bg-secondary",
}: {
  src: string;
  label: string;
  autoPlay?: boolean;
  muted?: boolean;
  onEnded?: () => void;
  onError?: () => void;
  fallbackLabel?: string;
  className?: string;
}) {
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
      onError?.();
      return;
    }
    const handleError = () => {
      setFailed(true);
      onError?.();
    };
    el.addEventListener("error", handleError);
    return () => el.removeEventListener("error", handleError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 text-muted-foreground ${className}`}
      >
        <Film className="size-5" />
        <span className="font-mono text-[11px] tracking-wide uppercase">
          {fallbackLabel}
        </span>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      autoPlay={autoPlay}
      muted={muted}
      preload="metadata"
      aria-label={label}
      onEnded={onEnded}
      className={className}
    />
  );
}
