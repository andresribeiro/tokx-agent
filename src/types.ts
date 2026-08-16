export type UsageProviderKind = "claude" | "codex" | "opencode" | "crush";

export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface UsageRecord {
  provider: UsageProviderKind;
  timestampMs: number;
  model: string;
  sessionId: string;
  totals: UsageTokenTotals;
  reportedCostUsd: number | null;
  dedupeKey: string | null;
}

export interface UsageBucket {
  day: string;
  provider: UsageProviderKind;
  model: string;
  totals: UsageTokenTotals;
  reportedCostUsd: number | null;
  unreportedTotals: UsageTokenTotals | null;
  unreportedRecords: number;
  records: number;
  sessions: number;
}

export interface WireTokenTotals {
  uncached_input_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

export interface WireBucket {
  day: string;
  provider: UsageProviderKind;
  model: string;
  totals: WireTokenTotals;
  unreported_totals: WireTokenTotals | null;
  cost_usd: number | null;
  records: number;
  unpriced_records: number;
  sessions: number;
}

export interface UsageReport {
  host_id: string;
  time_zone: string;
  since_day: string;
  until_day: string;
  reported_at: string;
  scan_duration_ms: number;
  buckets: WireBucket[];
}

export function totalTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

export function addTotals(
  a: UsageTokenTotals,
  b: UsageTokenTotals,
): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}
