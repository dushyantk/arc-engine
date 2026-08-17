"""Extracts evenly-spaced still frames from a video via ffmpeg/ffprobe.

Exists because Gemini's holistic video understanding was observed missing a
real defect: a suitcase duplicating across both hands for about a second,
then settling into the wrong one — verified by hand, frame by frame, after
the critic passed it clean on a retest with a tightened prompt and higher
media_resolution. Explicit numbered-frame comparison is what actually
catches this; see agents/critic.py.

Requires ffmpeg/ffprobe on PATH — a real infra dependency for the server
runtime, not just local dev tooling. Add to the eventual Dockerfile.
"""

import asyncio
import tempfile
from pathlib import Path


async def extract_frames(video_bytes: bytes, count: int = 12) -> list[tuple[float, bytes]]:
    """Returns `count` (timestamp_seconds, png_bytes) pairs, evenly spaced
    across the video's duration."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        video_path = tmp / "clip.mp4"
        video_path.write_bytes(video_bytes)

        probe = await asyncio.create_subprocess_exec(
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            str(video_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await probe.communicate()
        if probe.returncode != 0:
            raise RuntimeError(f"ffprobe failed: {stderr.decode()}")
        duration = float(stdout.decode().strip())

        frames: list[tuple[float, bytes]] = []
        for i in range(count):
            timestamp = duration * (i + 0.5) / count
            frame_path = tmp / f"frame_{i:02d}.png"
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-y",
                "-ss", f"{timestamp:.3f}",
                "-i", str(video_path),
                "-frames:v", "1",
                str(frame_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, ffmpeg_stderr = await proc.communicate()
            if proc.returncode != 0 or not frame_path.exists():
                raise RuntimeError(
                    f"ffmpeg frame extraction failed at t={timestamp:.3f}s: "
                    f"{ffmpeg_stderr.decode()}"
                )
            frames.append((timestamp, frame_path.read_bytes()))

        return frames
