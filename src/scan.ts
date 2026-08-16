import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
} from "./transcripts.ts";
import type { UsageProviderKind, UsageRecord } from "./types.ts";

// v3: Crush sessions that used several models now split their totals across
// those models instead of attributing everything to the last one.
const SCAN_CACHE_VERSION = 3;

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root);
  return found;
}

export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();

  try {
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}

interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  readonly records: readonly UsageRecord[];
}

export type ScanCache = Map<string, CachedFile>;

interface SerializedCache {
  readonly version: number;
  readonly files: Record<
    string,
    {
      readonly s: number;
      readonly m: number;
      readonly p: UsageProviderKind;
      readonly r: Array<{
        readonly ts: number;
        readonly model: string;
        readonly session: string;
        readonly u: number;
        readonly c: number;
        readonly w: number;
        readonly o: number;
        readonly rn: number;
        readonly dk: string | null;
        readonly cost: number | null;
      }>;
    }
  >;
}

export function encodeScanCache(cache: ScanCache): SerializedCache {
  const files: SerializedCache["files"] = {};
  for (const [path, entry] of cache) {
    files[path] = {
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      r: entry.records.map((record) => ({
        ts: record.timestampMs,
        model: record.model,
        session: record.sessionId,
        u: record.totals.uncachedInputTokens,
        c: record.totals.cachedInputTokens,
        w: record.totals.cacheCreationTokens,
        o: record.totals.outputTokens,
        rn: record.totals.reasoningTokens,
        dk: record.dedupeKey,
        cost: record.reportedCostUsd,
      })),
    };
  }
  return { version: SCAN_CACHE_VERSION, files };
}

export function decodeScanCache(document: unknown): ScanCache {
  const cache: ScanCache = new Map();
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  if (root.version !== SCAN_CACHE_VERSION) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    if (typeof raw.s !== "number" || typeof raw.m !== "number") continue;
    if (
      raw.p !== "claude" && raw.p !== "codex" && raw.p !== "opencode" &&
      raw.p !== "crush"
    ) {
      continue;
    }
    if (!Array.isArray(raw.r)) continue;

    const records: UsageRecord[] = [];
    let corrupt = false;
    for (const row of raw.r) {
      if (typeof row !== "object" || row === null) continue;
      const ts = row["ts"];
      const model = row["model"];
      const u = row["u"];
      const c = row["c"];
      const w = row["w"];
      const o = row["o"];
      const rn = row["rn"];
      if (
        typeof ts !== "number" ||
        !Number.isFinite(ts) ||
        typeof model !== "string" ||
        typeof u !== "number" ||
        typeof c !== "number" ||
        typeof w !== "number" ||
        typeof o !== "number" ||
        typeof rn !== "number"
      ) {
        corrupt = true;
        break;
      }
      records.push({
        provider: raw.p,
        timestampMs: ts,
        model,
        sessionId: typeof row["session"] === "string" ? row["session"] : "",
        totals: {
          uncachedInputTokens: u,
          cachedInputTokens: c,
          cacheCreationTokens: w,
          outputTokens: o,
          reasoningTokens: rn,
        },
        reportedCostUsd: typeof row["cost"] === "number" ? row["cost"] : null,
        dedupeKey: typeof row["dk"] === "string" ? row["dk"] : null,
      });
    }

    if (corrupt) continue;
    cache.set(path, { size: raw.s, mtimeMs: raw.m, provider: raw.p, records });
  }

  return cache;
}

export interface PruneOptions {
  readonly livePaths: ReadonlySet<string>;
  readonly walkedRoots: readonly string[];
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
}

export function pruneScanCache(
  cache: ScanCache,
  options: PruneOptions,
): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    const agedOut = entry.mtimeMs < options.retentionCutoffMs;
    const underWalkedRoot = options.walkedRoots.some((root) =>
      path.startsWith(root)
    );
    const deleted = underWalkedRoot && entry.mtimeMs >= options.windowStartMs &&
      !options.livePaths.has(path);
    if (agedOut || deleted) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

export function dedupeWithinFile(
  records: readonly UsageRecord[],
): readonly UsageRecord[] {
  const seen = new Set<string>();
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
