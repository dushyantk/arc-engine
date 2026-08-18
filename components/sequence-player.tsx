"use client";

import { useEffect, useState } from "react";
import { ShotVideo } from "@/components/shot-video";

type PlaybackItem = {
  shot: { code: string };
  approvedVersion: {
    versionNumber: number;
    videoAssetUrl: string | null;
    generationPrompt: string;
  } | null;
};

// How long the "approved, no footage stored" slate holds before advancing -
// long enough to read, short enough not to stall the cut.
const SLATE_DURATION_MS = 2800;

export function SequencePlayer({ items }: { items: PlaybackItem[] }) {
  // index and videoFailed change together (jumping shots always clears the
  // prior shot's failure state), so they're one state value updated
  // atomically - not two states with an effect syncing one to the other.
  const [{ index, videoFailed }, setPlayback] = useState({
    index: 0,
    videoFailed: false,
  });
  const current = items[index];
  // A version can carry a videoAssetUrl that points at nothing real (seed
  // data) - expectsVideo is only an optimistic guess until ShotVideo's own
  // load-error check (mirrors the same SSR race fix from the shot detail
  // page) confirms it one way or the other, via onError below.
  const expectsVideo = Boolean(current?.approvedVersion?.videoAssetUrl);
  const showSlate = !expectsVideo || videoFailed;
  const isLast = index === items.length - 1;

  const goTo = (i: number) => setPlayback({ index: i, videoFailed: false });
  const advance = () =>
    setPlayback((s) => ({
      index: s.index + 1 < items.length ? s.index + 1 : s.index,
      videoFailed: false,
    }));

  useEffect(() => {
    if (!showSlate || isLast) return;
    const timer = setTimeout(advance, SLATE_DURATION_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, showSlate, isLast]);

  if (!current) return null;

  return (
    <div>
      <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-secondary">
        {showSlate ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <p className="font-mono text-xs tracking-wide uppercase">
              {current.shot.code} &middot; approved, no footage stored
            </p>
          </div>
        ) : (
          <ShotVideo
            key={current.shot.code}
            src={`/api/media/${current.approvedVersion!.videoAssetUrl}`}
            label={`${current.shot.code} approved cut`}
            autoPlay
            muted
            onEnded={advance}
            onError={() => setPlayback((s) => ({ ...s, videoFailed: true }))}
            className="h-full w-full border-0"
          />
        )}
        <span className="absolute bottom-3 left-3 rounded bg-black/50 px-2 py-0.5 font-mono text-[11px] text-white/80">
          {current.shot.code}
          {current.approvedVersion
            ? ` · v${String(current.approvedVersion.versionNumber).padStart(3, "0")}`
            : ""}
        </span>
      </div>

      <div className="mt-4 flex gap-1.5">
        {items.map((item, i) => (
          <button
            key={item.shot.code}
            type="button"
            onClick={() => goTo(i)}
            aria-label={`Jump to ${item.shot.code}`}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i === index
                ? "bg-primary"
                : i < index
                  ? "bg-primary/40"
                  : "bg-border"
            }`}
          />
        ))}
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        {current.approvedVersion?.generationPrompt ??
          "No approved footage generated for this shot yet."}
      </p>

      {isLast ? (
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          End of sequence.
        </p>
      ) : null}
    </div>
  );
}
