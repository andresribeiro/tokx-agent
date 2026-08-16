import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { totalTokens } from "./types.ts";
import type { UsageRecord, UsageTokenTotals } from "./types.ts";

const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".nvm",
  ".bun",
  ".deno",
  ".local",
  ".config",
  "Library",
  "AppData",
  ".npm",
  ".pnpm-store",
  ".next",
  ".turbo",
  "target",
  "dist",
  "build",
  "vendor",
  ".gradle",
  ".cargo",
  ".rustup",
  ".pyenv",
  ".rvm",
]);

/**
 * Crush keeps one SQLite store per project (a `.crush/crush.db` in the working
 * directory, falling back to `~/.crush`), so discover every one under the given
 * roots instead of relying on a single global path.
 */
export function findCrushDatabases(
  roots: readonly string[],
  maxDepth: number,
): readonly string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (entry.name === ".crush") {
        const dbPath = join(dir, entry.name, "crush.db");
        try {
          if (Deno.statSync(dbPath).size > 0) found.push(dbPath);
        } catch {
          // No database in this .crush directory.
        }
        continue;
      }
      if (depth >= maxDepth || SKIPPED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  for (const root of roots) walk(root, 1);
  return found;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function optionalCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) as { present?: number } | undefined;
  return row !== undefined;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const row = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return row.some((entry) => entry.name === column);
}

/**
 * Read per-message usage from OpenCode's SQLite store. Newer sessions keep
 * their messages in `session_message`; older ones in `message`. Both carry the
 * same `tokens`/`cost` shape in `data`. Sessions whose messages no longer exist
 * (e.g. compacted) fall back to the session-level totals in `session_v2` /
 * `session`; sessions already covered by message rows are skipped there so
 * nothing is double counted.
 */
export function readOpencodeRecords(
  dbPath: string,
  sinceMs: number,
): readonly UsageRecord[] | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const records: UsageRecord[] = [];
    const coveredSessions = new Set<string>();

    const readMessageTable = (table: "message" | "session_message"): void => {
      const rows = db.prepare(
        `SELECT id, session_id, time_created, data
         FROM ${table}
         WHERE time_created >= ? AND data LIKE '%"tokens"%'
         ORDER BY time_created`,
      ).all(sinceMs) as Array<{
        id: string;
        session_id: string;
        time_created: number;
        data: string;
      }>;
      for (const row of rows) {
        const message = parseOpencodeMessage(
          row.data,
          row.id,
          row.session_id,
          row.time_created,
        );
        if (message === null) continue;
        coveredSessions.add(row.session_id);
        records.push(message);
      }
    };

    if (hasTable(db, "message")) readMessageTable("message");
    if (hasTable(db, "session_message")) readMessageTable("session_message");

    // Session-level fallback for sessions with no message-level usage rows.
    const readSessionTable = (table: "session" | "session_v2"): void => {
      // Older OpenCode schemas predate the time_archived column; skip the
      // archived filter for them so the whole read does not fail.
      const archivedFilter = hasColumn(db, table, "time_archived")
        ? "AND time_archived IS NULL"
        : "";
      const rows = db.prepare(
        `SELECT id, model, cost, tokens_input, tokens_output,
                tokens_reasoning, tokens_cache_read, tokens_cache_write,
                time_updated
         FROM ${table}
         WHERE time_updated >= ? ${archivedFilter}
         ORDER BY time_updated`,
      ).all(sinceMs) as Array<{
        id: string;
        model: string;
        cost: number;
        tokens_input: number;
        tokens_output: number;
        tokens_reasoning: number;
        tokens_cache_read: number;
        tokens_cache_write: number;
        time_updated: number;
      }>;
      for (const row of rows) {
        if (coveredSessions.has(row.id)) continue;
        coveredSessions.add(row.id);
        const totals: UsageTokenTotals = {
          uncachedInputTokens: int(row.tokens_input),
          cachedInputTokens: int(row.tokens_cache_read),
          cacheCreationTokens: int(row.tokens_cache_write),
          outputTokens: int(row.tokens_output),
          reasoningTokens: int(row.tokens_reasoning),
        };
        if (totalTokens(totals) === 0) continue;
        records.push({
          provider: "opencode",
          timestampMs: row.time_updated,
          model: parseOpencodeModel(row.model),
          sessionId: row.id,
          totals,
          reportedCostUsd: optionalCost(row.cost),
          dedupeKey: `session:${row.id}`,
        });
      }
    };

    if (hasTable(db, "session_v2")) readSessionTable("session_v2");
    if (hasTable(db, "session")) readSessionTable("session");

    return records;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function parseOpencodeMessage(
  data: string,
  id: string,
  sessionId: string,
  timestampMs: number,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const role = record["role"];
  if (role !== undefined && role !== "assistant") return null;

  const model = parseOpencodeModelField(record);
  if (model.length === 0) return null;

  const tokens = record["tokens"];
  if (typeof tokens !== "object" || tokens === null) return null;
  const tokensRecord = tokens as Record<string, unknown>;
  const cache = tokensRecord["cache"];
  const cacheRecord = typeof cache === "object" && cache !== null
    ? (cache as Record<string, unknown>)
    : {};

  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(tokensRecord["input"]),
    cachedInputTokens: int(cacheRecord["read"]),
    cacheCreationTokens: int(cacheRecord["write"]),
    outputTokens: int(tokensRecord["output"]),
    reasoningTokens: int(tokensRecord["reasoning"]),
  };
  if (totalTokens(totals) === 0) return null;

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd: optionalCost(record["cost"]),
    dedupeKey: `message:${id}`,
  };
}

function parseOpencodeModelField(record: Record<string, unknown>): string {
  const direct = record["modelID"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = record["model"];
  if (typeof nested === "object" && nested !== null) {
    const id = (nested as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return "";
}

function parseOpencodeModel(modelJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelJson);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const id = (parsed as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : "";
}

/**
 * Read session-level usage from Crush's SQLite store. Sessions only track
 * aggregate prompt/completion tokens and a provider-reported cost; the model is
 * taken from the session's most recent assistant message, if any.
 */
export function readCrushRecords(
  dbPath: string,
  sinceMs: number,
): readonly UsageRecord[] | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const sinceSeconds = Math.floor(sinceMs / 1000);
    const hasMessages = hasTable(db, "messages");
    const modelSubquery = hasMessages
      ? `(SELECT m.model FROM messages m
         WHERE m.session_id = s.id AND m.model != ''
         ORDER BY m.created_at DESC LIMIT 1)`
      : `NULL`;
    const rows = db.prepare(
      `SELECT s.id, s.prompt_tokens, s.completion_tokens, s.cost, s.updated_at,
              ${modelSubquery} AS model
       FROM sessions s
       WHERE s.updated_at >= ? AND s.prompt_tokens > 0
       ORDER BY s.updated_at`,
    ).all(sinceSeconds) as Array<{
      id: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost: number;
      updated_at: number;
      model: string | null;
    }>;

    return rows.map((row) => ({
      provider: "crush",
      timestampMs: row.updated_at * 1000,
      model: typeof row.model === "string" ? row.model : "",
      sessionId: row.id,
      totals: {
        uncachedInputTokens: int(row.prompt_tokens),
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: int(row.completion_tokens),
        reasoningTokens: 0,
      },
      reportedCostUsd: optionalCost(row.cost),
      dedupeKey: `session:${row.id}`,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
