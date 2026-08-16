import { hostname } from "node:os";
import { join } from "node:path";

import { makeDayFormatter, UsageAggregator } from "./src/aggregation.ts";
import { loadConfig } from "./src/config.ts";
import {
  findCrushDatabases,
  readCrushRecords,
  readOpencodeRecords,
} from "./src/db.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  listTranscriptFiles,
  pruneScanCache,
  readTranscriptRecords,
  type ScanCache,
} from "./src/scan.ts";
import { uploadReport } from "./src/upload.ts";
import type {
  UsageBucket,
  UsageProviderKind,
  UsageRecord,
  UsageReport,
  WireBucket,
} from "./src/types.ts";

const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const CACHE_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(
  day: string,
  offset: number,
  formatter: (ms: number) => string,
): string {
  const base = Date.parse(`${day}T00:00:00Z`);
  return formatter(base + offset * DAY_MS);
}

function toWireBucket(bucket: UsageBucket): WireBucket {
  const toTotals = (totals: UsageBucket["totals"]) => ({
    uncached_input_tokens: totals.uncachedInputTokens,
    cached_input_tokens: totals.cachedInputTokens,
    cache_creation_tokens: totals.cacheCreationTokens,
    output_tokens: totals.outputTokens,
    reasoning_tokens: totals.reasoningTokens,
  });
  return {
    day: bucket.day,
    provider: bucket.provider,
    model: bucket.model,
    totals: toTotals(bucket.totals),
    unreported_totals: bucket.unreportedTotals === null
      ? null
      : toTotals(bucket.unreportedTotals),
    cost_usd: bucket.reportedCostUsd,
    records: bucket.records,
    unpriced_records: bucket.unreportedRecords,
    sessions: bucket.sessions,
  };
}

async function loadScanCache(stateDir: string): Promise<ScanCache> {
  try {
    const raw = await Deno.readTextFile(
      join(stateDir, "usage-scan-cache.json"),
    );
    return decodeScanCache(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

async function persistScanCache(
  stateDir: string,
  cache: ScanCache,
): Promise<void> {
  try {
    await Deno.writeTextFile(
      join(stateDir, "usage-scan-cache.json"),
      JSON.stringify(encodeScanCache(cache)),
    );
  } catch {
    // A cache we cannot write only costs a slower next start.
  }
}

interface ProviderDirs {
  readonly provider: "claude" | "codex";
  readonly dir: string;
}

interface ProviderDb {
  readonly provider: "opencode" | "crush";
  readonly path: string;
}

async function recordsForSource(
  path: string,
  provider: UsageProviderKind,
  size: number,
  mtimeMs: number,
  cache: ScanCache,
  windowStartMs: number,
): Promise<readonly UsageRecord[] | null> {
  const cached = cache.get(path);
  if (
    cached &&
    cached.size === size &&
    cached.mtimeMs === mtimeMs &&
    cached.provider === provider
  ) {
    return cached.records;
  }
  const parsed = provider === "opencode"
    ? readOpencodeRecords(path, windowStartMs)
    : provider === "crush"
    ? readCrushRecords(path, windowStartMs)
    : await readTranscriptRecords(path, provider);
  if (parsed === null) return null;
  const records = dedupeWithinFile(parsed);
  cache.set(path, { size, mtimeMs, provider, records });
  return records;
}

async function runOnce(config: ReturnType<typeof loadConfig>): Promise<number> {
  const startedAtMs = Date.now();
  const toDay = makeDayFormatter(config.timeZone);
  const untilDay = toDay(Date.now());
  const sinceDay = addDays(untilDay, -(config.windowDays - 1), toDay);
  const windowStartMs = Date.parse(`${sinceDay}T00:00:00Z`);

  const cache = await loadScanCache(config.stateDir);
  const aggregator = new UsageAggregator({
    timeZone: config.timeZone,
    sinceDay,
    untilDay,
  });

  const dirs: ProviderDirs[] = [
    { provider: "claude", dir: config.claudeProjectsDir },
    { provider: "codex", dir: config.codexSessionsDir },
  ];
  const dbs: ProviderDb[] = [{
    provider: "opencode",
    path: config.opencodeDbPath,
  }];
  if (config.crushDbPath !== null) {
    dbs.push({ provider: "crush", path: config.crushDbPath });
  } else {
    for (
      const path of findCrushDatabases(
        config.crushScanRoots,
        config.crushScanDepth,
      )
    ) {
      dbs.push({ provider: "crush", path });
    }
  }

  let scannedFiles = 0;
  let skippedFiles = 0;
  const distinctSessions = new Set<string>();
  const livePaths = new Set<string>();
  const walkedRoots: string[] = [];

  const consume = (records: readonly UsageRecord[] | null): void => {
    if (records === null || records.length === 0) {
      skippedFiles += 1;
      return;
    }
    scannedFiles += 1;
    for (const record of records) {
      if (aggregator.add(record) && record.sessionId.length > 0) {
        distinctSessions.add(record.sessionId);
      }
    }
  };

  for (const { provider, dir } of dirs) {
    try {
      Deno.statSync(dir);
    } catch {
      continue;
    }
    walkedRoots.push(dir);
    const files = await listTranscriptFiles(
      dir,
      windowStartMs - MTIME_SLACK_MS,
    );
    for (const file of files) {
      livePaths.add(file.path);
      consume(
        await recordsForSource(
          file.path,
          provider,
          file.size,
          file.mtimeMs,
          cache,
          windowStartMs,
        ),
      );
    }
  }

  for (const { provider, path } of dbs) {
    let stats;
    try {
      stats = await Deno.stat(path);
    } catch {
      continue;
    }
    if (stats.size === 0) continue;
    livePaths.add(path);
    walkedRoots.push(path);
    consume(
      await recordsForSource(
        path,
        provider,
        stats.size,
        stats.mtime?.getTime() ?? 0,
        cache,
        windowStartMs,
      ),
    );
  }

  const pruned = pruneScanCache(cache, {
    livePaths,
    walkedRoots,
    windowStartMs: windowStartMs - MTIME_SLACK_MS,
    retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * DAY_MS,
  });
  await persistScanCache(config.stateDir, cache);

  const aggregated = aggregator.finish();
  const buckets = aggregated.buckets;
  const reportedCostUsd = buckets.reduce(
    (sum, bucket) => sum + (bucket.reportedCostUsd ?? 0),
    0,
  );
  const totalTokens = buckets.reduce(
    (sum, bucket) =>
      sum +
      bucket.totals.uncachedInputTokens +
      bucket.totals.cachedInputTokens +
      bucket.totals.cacheCreationTokens +
      bucket.totals.outputTokens,
    0,
  );

  const report: UsageReport = {
    host_id: hostname(),
    time_zone: config.timeZone,
    since_day: sinceDay,
    until_day: untilDay,
    reported_at: new Date(startedAtMs).toISOString(),
    scan_duration_ms: Date.now() - startedAtMs,
    buckets: buckets.map(toWireBucket),
  };

  console.log(
    JSON.stringify({
      since_day: sinceDay,
      until_day: untilDay,
      scanned_files: scannedFiles,
      skipped_files: skippedFiles,
      sessions: distinctSessions.size,
      buckets: buckets.length,
      duplicates_dropped: aggregated.duplicatesDropped,
      reported_cost_usd: reportedCostUsd,
      total_tokens: totalTokens,
      pruned_cache_entries: pruned,
    }),
  );

  let upload;
  try {
    upload = await uploadReport(config.backendUrl, config.token, report);
  } catch (error) {
    console.error(
      `upload failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
  if (upload.status >= 200 && upload.status < 300) {
    console.log(`upload ok (${upload.status})`);
  } else {
    console.error(`upload failed (${upload.status}): ${upload.body}`);
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const config = loadConfig();
  await Deno.mkdir(config.stateDir, { recursive: true });

  let exitCode = 0;
  for (;;) {
    exitCode = await runOnce(config);
    if (config.intervalSeconds <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, config.intervalSeconds * 1000)
    );
  }
  Deno.exit(exitCode);
}

if (import.meta.main) {
  await main();
}
