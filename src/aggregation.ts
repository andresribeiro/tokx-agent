import { EMPTY_TOTALS } from "./transcripts.ts";
import { addTotals } from "./types.ts";
import type { UsageBucket, UsageRecord, UsageTokenTotals } from "./types.ts";

export function makeDayFormatter(
  timeZone: string,
): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return (timestampMs) => format.format(new Date(timestampMs));
}

interface MutableBucket {
  totals: UsageTokenTotals;
  reportedCostUsd: number;
  unreportedTotals: UsageTokenTotals | null;
  unreportedRecords: number;
  records: number;
  sessions: Set<string>;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
}

export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #sinceDay: string;
  readonly #untilDay: string;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#sinceDay = options.sinceDay;
    this.#untilDay = options.untilDay;
    this.#toDay = makeDayFormatter(options.timeZone);
  }

  add(record: UsageRecord): boolean {
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(record.dedupeKey);
    }

    const day = this.#toDay(record.timestampMs);
    if (day < this.#sinceDay || day > this.#untilDay) {
      this.#outOfWindow += 1;
      return false;
    }

    const key = `${day}\u0000${record.provider}\u0000${record.model}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: EMPTY_TOTALS,
        reportedCostUsd: 0,
        unreportedTotals: null,
        unreportedRecords: 0,
        records: 0,
        sessions: new Set<string>(),
      };
      this.#buckets.set(key, bucket);
    }

    bucket.totals = addTotals(bucket.totals, record.totals);
    if (record.reportedCostUsd !== null) {
      bucket.reportedCostUsd += record.reportedCostUsd;
    } else {
      // These records are priced server-side against the rate table; the
      // server needs their token totals separately so mixed buckets are not
      // double-counted.
      bucket.unreportedTotals = bucket.unreportedTotals === null
        ? { ...record.totals }
        : addTotals(bucket.unreportedTotals, record.totals);
      bucket.unreportedRecords += 1;
    }
    bucket.records += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    return true;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", provider = "", model = ""] = key.split("\u0000");
      buckets.push({
        day,
        provider: provider as UsageBucket["provider"],
        model,
        totals: bucket.totals,
        reportedCostUsd: bucket.reportedCostUsd === 0 &&
            bucket.unreportedRecords === bucket.records
          ? null
          : bucket.reportedCostUsd,
        unreportedTotals: bucket.unreportedTotals,
        unreportedRecords: bucket.unreportedRecords,
        records: bucket.records,
        sessions: bucket.sessions.size,
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    return {
      buckets,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}
