import { marked } from "marked";
import { getMinioClient, getObjectBytes, MINIO_BUCKET } from "@/lib/minio";

// The build record, read from object storage rather than the working directory.
// generations/ is gitignored on purpose - real generated video does not belong
// in git history - so `pnpm ledger:sync` publishes it under build-artifacts/ and
// this reads from there. The page therefore shows the last sync, which is why
// syncedAt is surfaced rather than hidden.

export const LEDGER_KEY = "build-artifacts/LEDGER.md";
const MEDIA_PREFIX = "/api/media/build-artifacts";

export type LedgerEpisode = {
  /** The leading number in "### 12. Landing page ...", when there is one. */
  number: number | null;
  title: string;
  html: string;
  /** Media files this episode names, resolved to servable URLs. */
  media: { key: string; url: string; kind: "video" | "image" }[];
};

export type LedgerPhase = {
  title: string;
  intro: string;
  episodes: LedgerEpisode[];
};

export type Ledger = {
  title: string;
  preamble: string;
  phases: LedgerPhase[];
  episodeCount: number;
  syncedAt: string | null;
};

// Paths as the ledger writes them: SH020/v006.mp4, SH020/diagnostic_frames/t1.0s.png.
const MEDIA_PATTERN = /`(SH\d+\/[A-Za-z0-9_./-]+\.(?:mp4|png|jpe?g))`/g;

function mediaFrom(markdown: string): LedgerEpisode["media"] {
  const seen = new Set<string>();
  const found: LedgerEpisode["media"] = [];
  for (const match of markdown.matchAll(MEDIA_PATTERN)) {
    const key = match[1];
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      key,
      url: `${MEDIA_PREFIX}/${key}`,
      kind: key.endsWith(".mp4") ? "video" : "image",
    });
  }
  return found;
}

function render(markdown: string): string {
  // marked.parse is synchronous unless async options are set; none are here.
  return marked.parse(markdown, { async: false }) as string;
}

/**
 * Splits the ledger into its phases (h2) and numbered episodes (h3).
 *
 * The rendered HTML is inserted with dangerouslySetInnerHTML, which is safe for
 * exactly one reason: this file is first-party, written by hand into the repo
 * and published by an operator running `pnpm ledger:sync`. It is not user input
 * and there is no path by which a visitor can influence it. If that ever stops
 * being true - a ledger uploaded through the product, say - this needs
 * sanitising before it renders.
 */
export function parseLedger(markdown: string, syncedAt: string | null): Ledger {
  const lines = markdown.split("\n");

  const titleLine = lines.find((line) => line.startsWith("# ")) ?? "# Generation Ledger";
  const title = titleLine.replace(/^#\s+/, "").trim();

  const phases: LedgerPhase[] = [];
  let current: LedgerPhase | null = null;
  let episode: LedgerEpisode | null = null;
  let buffer: string[] = [];
  const preamble: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    if (episode) {
      episode.html = render(text);
      episode.media = mediaFrom(text);
    } else if (current) {
      current.intro = render(text);
    } else {
      preamble.push(text);
    }
  };

  for (const line of lines) {
    if (line.startsWith("# ") && !line.startsWith("## ")) continue;

    if (line.startsWith("## ")) {
      flush();
      if (episode && current) current.episodes.push(episode);
      episode = null;
      current = { title: line.replace(/^##\s+/, "").trim(), intro: "", episodes: [] };
      phases.push(current);
      continue;
    }

    if (line.startsWith("### ")) {
      flush();
      if (episode && current) current.episodes.push(episode);
      const heading = line.replace(/^###\s+/, "").trim();
      const numbered = /^(\d+)\.\s*(.*)$/.exec(heading);
      episode = {
        number: numbered ? Number(numbered[1]) : null,
        title: numbered ? numbered[2] : heading,
        html: "",
        media: [],
      };
      continue;
    }

    buffer.push(line);
  }
  flush();
  if (episode && current) current.episodes.push(episode);

  return {
    title,
    preamble: preamble.length > 0 ? render(preamble.join("\n\n")) : "",
    phases,
    episodeCount: phases.reduce((sum, phase) => sum + phase.episodes.length, 0),
    syncedAt,
  };
}

export type ArtifactGroup = {
  /** Directory under generations/, e.g. "SH020/diagnostic_frames_v005". */
  path: string;
  files: { key: string; url: string; name: string; kind: "video" | "image"; bytes: number }[];
};

/**
 * Everything actually in the store, grouped by folder.
 *
 * The narrative cites whole directories ("diagnostic_frames_v005/") far more
 * often than individual files, so parsing references out of the prose surfaces
 * about five of the twenty-odd artefacts. Listing the prefix shows what is
 * really preserved rather than what happened to get named inline.
 */
export async function listBuildArtifacts(): Promise<ArtifactGroup[]> {
  const client = getMinioClient();
  const groups = new Map<string, ArtifactGroup>();

  try {
    const stream = client.listObjectsV2(MINIO_BUCKET, "build-artifacts/", true);
    for await (const item of stream) {
      const key = item.name;
      if (!key || key.endsWith(".md")) continue;
      const relative = key.slice("build-artifacts/".length);
      const slash = relative.lastIndexOf("/");
      const dir = slash === -1 ? "." : relative.slice(0, slash);
      const name = relative.slice(slash + 1);
      const kind = name.endsWith(".mp4") ? ("video" as const) : ("image" as const);

      let group = groups.get(dir);
      if (!group) {
        group = { path: dir, files: [] };
        groups.set(dir, group);
      }
      group.files.push({
        key: relative,
        url: `${MEDIA_PREFIX}/${relative}`,
        name,
        kind,
        bytes: item.size ?? 0,
      });
    }
  } catch {
    return [];
  }

  for (const group of groups.values()) {
    group.files.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Null when the ledger has never been synced - the page explains how. */
export async function getLedger(): Promise<Ledger | null> {
  try {
    const [bytes, stat] = await Promise.all([
      getObjectBytes(LEDGER_KEY),
      getMinioClient().statObject(MINIO_BUCKET, LEDGER_KEY),
    ]);
    // Object mtime, not "now": the page shows the last sync, and saying so is
    // the difference between a stale exhibit and a dated one.
    const syncedAt = stat.lastModified ? stat.lastModified.toISOString() : null;
    return parseLedger(bytes.toString("utf8"), syncedAt);
  } catch {
    return null;
  }
}
