import { assert, assertEquals } from "./helpers.ts";
import { UsageAggregator } from "../src/aggregation.ts";
import {
  findCrushDatabases,
  readCrushRecords,
  readOpencodeRecords,
  sqliteFingerprint,
} from "../src/db.ts";
import {
  initialCodexScanState,
  parseClaudeLine,
  parseCodexLine,
} from "../src/transcripts.ts";
import { dedupeWithinFile } from "../src/scan.ts";
import { recordsForSource } from "../main.ts";
import type { UsageRecord } from "../src/types.ts";
import { DatabaseSync } from "node:sqlite";

function claudeAssistantLine(
  overrides: Record<string, unknown> = {},
): string {
  const line = {
    type: "assistant",
    timestamp: "2026-08-15T10:00:00.000Z",
    requestId: "req-1",
    sessionId: "sess-1",
    message: {
      id: "msg-1",
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
        output_tokens: 50,
      },
    },
    ...overrides,
  };
  return JSON.stringify(line);
}

Deno.test("claude - parses assistant usage records", () => {
  const record = parseClaudeLine(claudeAssistantLine());
  assert(record !== null);
  assertEquals(record.provider, "claude");
  assertEquals(record.model, "claude-sonnet-4-5");
  assertEquals(record.sessionId, "sess-1");
  assertEquals(record.dedupeKey, "msg-1:req-1");
  assertEquals(record.totals, {
    uncachedInputTokens: 100,
    cachedInputTokens: 200,
    cacheCreationTokens: 30,
    outputTokens: 50,
    reasoningTokens: 0,
  });
  assertEquals(record.reportedCostUsd, null);
});

Deno.test("claude - reads provider-reported cost", () => {
  const record = parseClaudeLine(
    claudeAssistantLine({ costUSD: 0.0123 }),
  );
  assert(record !== null);
  assertEquals(record.reportedCostUsd, 0.0123);
});

Deno.test("claude - ignores non-assistant lines and garbage", () => {
  assertEquals(
    parseClaudeLine(JSON.stringify({ type: "user", message: {} })),
    null,
  );
  assertEquals(parseClaudeLine("not json"), null);
  assertEquals(
    parseClaudeLine(claudeAssistantLine({ message: { model: "x" } })),
    null,
  );
});

Deno.test("claude - same content block repeated is deduped within a file", () => {
  const line = claudeAssistantLine();
  const records = dedupeWithinFile([
    parseClaudeLine(line)!,
    parseClaudeLine(line)!,
  ]);
  assertEquals(records.length, 1);
});

Deno.test("codex - aggregates token_count into totals", () => {
  const state = initialCodexScanState();
  parseCodexLine(
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-15T10:00:00.000Z",
      payload: { id: "sess-9", type: "session_meta" },
    }),
    state,
  );
  parseCodexLine(
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-15T10:00:01.000Z",
      payload: { type: "turn_context", model: "gpt-5.2" },
    }),
    state,
  );
  const record = parseCodexLine(
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-15T10:00:02.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 500,
            cached_input_tokens: 200,
            cache_write_input_tokens: 100,
            output_tokens: 80,
            reasoning_output_tokens: 20,
          },
        },
      },
    }),
    state,
  );
  assert(record !== null);
  assertEquals(record.sessionId, "sess-9");
  assertEquals(record.totals, {
    uncachedInputTokens: 200,
    cachedInputTokens: 200,
    cacheCreationTokens: 100,
    outputTokens: 80,
    reasoningTokens: 20,
  });
});

Deno.test("codex - drops consecutive duplicate token_count events", () => {
  const state = initialCodexScanState();
  const tokenLine = JSON.stringify({
    type: "response_item",
    timestamp: "2026-08-15T10:00:02.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 500,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 80,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
  parseCodexLine(
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-15T10:00:01.000Z",
      payload: { type: "turn_context", model: "gpt-5.2" },
    }),
    state,
  );
  const first = parseCodexLine(tokenLine, state);
  const second = parseCodexLine(tokenLine, state);
  assert(first !== null);
  assertEquals(second, null);
});

Deno.test("codex - suppresses forked session history copies", () => {
  const state = initialCodexScanState();
  parseCodexLine(
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-15T10:00:00.000Z",
      payload: {
        id: "fork-1",
        type: "session_meta",
        forked_from_id: "parent-1",
      },
    }),
    state,
  );
  parseCodexLine(
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-15T10:00:00.100Z",
      payload: { type: "turn_context", model: "gpt-5.2" },
    }),
    state,
  );
  const copy = parseCodexLine(
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-15T10:00:00.200Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 500,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 80,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
    state,
  );
  assertEquals(copy, null);
});

Deno.test("aggregation - buckets by day, provider and model and dedupes globally", () => {
  const aggregator = new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-14",
    untilDay: "2026-08-15",
  });
  const day1 = parseClaudeLine(claudeAssistantLine())!;
  const day2 = parseClaudeLine(
    claudeAssistantLine({
      timestamp: "2026-08-14T09:00:00.000Z",
      requestId: "req-2",
      message: { ...JSON.parse(claudeAssistantLine()).message, id: "msg-2" },
    }),
  )!;
  const duplicate = parseClaudeLine(claudeAssistantLine())!;

  assertEquals(aggregator.add(day1), true);
  assertEquals(aggregator.add(day2), true);
  assertEquals(aggregator.add(duplicate), false);

  const { buckets, duplicatesDropped } = aggregator.finish();
  assertEquals(duplicatesDropped, 1);
  assertEquals(buckets.length, 2);
  assertEquals(buckets[0].day, "2026-08-14");
  assertEquals(buckets[1].day, "2026-08-15");
  assertEquals(buckets[1].totals.uncachedInputTokens, 100);
  assertEquals(buckets[1].sessions, 1);
});

Deno.test("aggregation - buckets carry provider-reported cost and unreported totals", () => {
  const aggregator = new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-15",
    untilDay: "2026-08-15",
  });
  const reported = parseClaudeLine(
    claudeAssistantLine({
      requestId: "req-1",
      costUSD: 0.0123,
      message: {
        ...JSON.parse(claudeAssistantLine()).message,
        id: "msg-1",
      },
    }),
  )!;
  const unreported = parseClaudeLine(
    claudeAssistantLine({
      requestId: "req-2",
      message: {
        ...JSON.parse(claudeAssistantLine()).message,
        id: "msg-2",
      },
    }),
  )!;
  assertEquals(aggregator.add(reported), true);
  assertEquals(aggregator.add(unreported), true);

  const { buckets } = aggregator.finish();
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].reportedCostUsd, 0.0123);
  assertEquals(buckets[0].unreportedRecords, 1);
  assertEquals(buckets[0].unreportedTotals, {
    uncachedInputTokens: 100,
    cachedInputTokens: 200,
    cacheCreationTokens: 30,
    outputTokens: 50,
    reasoningTokens: 0,
  });
  // Totals cover both records; the reported cost does not.
  assertEquals(buckets[0].totals.uncachedInputTokens, 200);
});

Deno.test("aggregation - a bucket with no provider-reported cost sends null", () => {
  const aggregator = new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-15",
    untilDay: "2026-08-15",
  });
  assertEquals(aggregator.add(parseClaudeLine(claudeAssistantLine())!), true);
  const { buckets } = aggregator.finish();
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].reportedCostUsd, null);
  assertEquals(buckets[0].unreportedRecords, 1);
  assertEquals(buckets[0].unreportedTotals, buckets[0].totals);
});

Deno.test("aggregation - all-provider-reported bucket has no unreported totals", () => {
  const aggregator = new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-15",
    untilDay: "2026-08-15",
  });
  const line = claudeAssistantLine({
    costUSD: 0.0042,
    requestId: "req-1",
  });
  assertEquals(aggregator.add(parseClaudeLine(line)!), true);
  const { buckets } = aggregator.finish();
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].reportedCostUsd, 0.0042);
  assertEquals(buckets[0].unreportedTotals, null);
  assertEquals(buckets[0].unreportedRecords, 0);
});

Deno.test("aggregation - out-of-window records are dropped", () => {
  const aggregator = new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-15",
    untilDay: "2026-08-15",
  });
  const old = parseClaudeLine(
    claudeAssistantLine({ timestamp: "2026-08-01T09:00:00.000Z" }),
  )!;
  assertEquals(aggregator.add(old), false);
  const { buckets, outOfWindow } = aggregator.finish();
  assertEquals(buckets.length, 0);
  assertEquals(outOfWindow, 1);
});

Deno.test("aggregation - crush sessions keep their provider-reported cost", () => {
  const aggregator = new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-10",
    untilDay: "2026-08-10",
  });
  const record: UsageRecord = {
    provider: "crush",
    timestampMs: 1786373253000,
    model: "deepseek-v4-flash",
    sessionId: "s-1",
    totals: {
      uncachedInputTokens: 41927,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 198,
      reasoningTokens: 0,
    },
    reportedCostUsd: 0.0027,
    dedupeKey: "session:s-1",
  };
  assertEquals(aggregator.add(record), true);
  const { buckets } = aggregator.finish();
  assertEquals(buckets.length, 1);
  // Raw totals are sent as-is; the fixed cache-hit split is applied when the
  // server prices the bucket.
  assertEquals(buckets[0].totals, record.totals);
  assertEquals(buckets[0].reportedCostUsd, 0.0027);
  assertEquals(buckets[0].unreportedTotals, null);
});

function withTempDb(setup: (db: DatabaseSync) => void): string {
  const path = Deno.makeTempFileSync({ suffix: ".db" });
  const db = new DatabaseSync(path);
  try {
    setup(db);
  } finally {
    db.close();
  }
  return path;
}

Deno.test("opencode - reads per-message usage from both message tables", () => {
  const path = withTempDb((db) => {
    db.exec(
      `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
         time_created INTEGER NOT NULL, data TEXT NOT NULL);
       CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
         type TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`,
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)",
    ).run(
      "msg-1",
      "sess-a",
      1786373251035,
      JSON.stringify({
        role: "assistant",
        modelID: "deepseek-v4-flash",
        providerID: "opencode-go",
        cost: 0.001,
        tokens: {
          total: 110,
          input: 50,
          output: 20,
          reasoning: 5,
          cache: { read: 30, write: 10 },
        },
      }),
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)",
    ).run(
      "msg-2",
      "sess-a",
      1786373252035,
      JSON.stringify({ role: "user", text: "hi" }),
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)",
    ).run(
      "msg-3",
      "sess-a",
      1786373253035,
      JSON.stringify({
        role: "assistant",
        modelID: "deepseek-v4-flash",
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    );
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?,?,?,?,?)",
    ).run(
      "msg-4",
      "sess-b",
      "assistant",
      1786665186228,
      JSON.stringify({
        model: { id: "deepseek-v4-flash", providerID: "opencode-go" },
        cost: 0.002,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 2,
          cache: { read: 20, write: 0 },
        },
      }),
    );
  });
  try {
    const records = readOpencodeRecords(path, 0);
    assert(records !== null);
    // msg-1 and msg-4; msg-2 has no tokens, msg-3 is an aborted zero-token reply.
    assertEquals(records.length, 2);
    const byKey = new Map(records.map((r) => [r.dedupeKey, r]));
    const msg1 = byKey.get("message:msg-1")!;
    assertEquals(msg1.provider, "opencode");
    assertEquals(msg1.model, "deepseek-v4-flash");
    assertEquals(msg1.sessionId, "sess-a");
    assertEquals(msg1.timestampMs, 1786373251035);
    assertEquals(msg1.reportedCostUsd, 0.001);
    assertEquals(msg1.totals, {
      uncachedInputTokens: 50,
      cachedInputTokens: 30,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
    });
    const msg4 = byKey.get("message:msg-4")!;
    assertEquals(msg4.model, "deepseek-v4-flash");
    assertEquals(msg4.sessionId, "sess-b");
    assertEquals(msg4.totals.outputTokens, 10);
    assertEquals(msg4.reportedCostUsd, 0.002);
  } finally {
    Deno.removeSync(path);
  }
});

Deno.test("opencode - message rows before the window are skipped", () => {
  const path = withTempDb((db) => {
    db.exec(
      `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
         time_created INTEGER NOT NULL, data TEXT NOT NULL)`,
    );
    const insert = (id: string, ts: number) =>
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)",
      ).run(
        id,
        "sess-a",
        ts,
        JSON.stringify({
          role: "assistant",
          modelID: "m1",
          tokens: {
            input: 10,
            output: 10,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }),
      );
    insert("old", 1786373251000);
    insert("new", 1786373252000);
  });
  try {
    const records = readOpencodeRecords(path, 1786373251500);
    assert(records !== null);
    assertEquals(records.length, 1);
    assertEquals(records[0].dedupeKey, "message:new");
  } finally {
    Deno.removeSync(path);
  }
});

Deno.test("opencode - falls back to session totals for uncovered sessions", () => {
  const path = withTempDb((db) => {
    db.exec(
      `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
         time_created INTEGER NOT NULL, data TEXT NOT NULL);
       CREATE TABLE session_v2 (id TEXT PRIMARY KEY, model TEXT, cost REAL,
         tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
         tokens_cache_read INTEGER, tokens_cache_write INTEGER,
         time_updated INTEGER, time_archived INTEGER);
       CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT, cost REAL,
         tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
         tokens_cache_read INTEGER, tokens_cache_write INTEGER,
         time_updated INTEGER, time_archived INTEGER)`,
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)",
    ).run(
      "msg-1",
      "sess-covered",
      1786373251035,
      JSON.stringify({
        role: "assistant",
        modelID: "m1",
        tokens: {
          input: 10,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    );
    const sessionInsert = (table: string, id: string, ts: number) =>
      db.prepare(
        `INSERT INTO ${table} (id, model, cost, tokens_input, tokens_output,
           tokens_reasoning, tokens_cache_read, tokens_cache_write,
           time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        '{"id":"m2","providerID":"opencode-go"}',
        0.2,
        100,
        50,
        5,
        25,
        0,
        ts,
        null,
      );
    sessionInsert("session_v2", "sess-covered", 1786373252035);
    sessionInsert("session_v2", "sess-fallback", 1786373253035);
    sessionInsert("session", "sess-fallback", 1786373253036);
  });
  try {
    const records = readOpencodeRecords(path, 0);
    assert(records !== null);
    // msg-1 + one session-level record; sess-covered is skipped (covered by
    // messages) and the duplicate session row in `session` is ignored.
    assertEquals(records.length, 2);
    const fallback = records.find((r) => r.sessionId === "sess-fallback")!;
    assertEquals(fallback.dedupeKey, "session:sess-fallback");
    assertEquals(fallback.model, "m2");
    assertEquals(fallback.totals, {
      uncachedInputTokens: 100,
      cachedInputTokens: 25,
      cacheCreationTokens: 0,
      outputTokens: 50,
      reasoningTokens: 5,
    });
    assertEquals(fallback.reportedCostUsd, 0.2);
    assertEquals(
      records.filter((r) => r.sessionId === "sess-covered").length,
      1,
    );
  } finally {
    Deno.removeSync(path);
  }
});

Deno.test("crush - reads session totals with the last assistant model", () => {
  const path = withTempDb((db) => {
    db.exec(
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, prompt_tokens INTEGER,
         completion_tokens INTEGER, cost REAL, updated_at INTEGER);
       CREATE TABLE messages (session_id TEXT, model TEXT, created_at INTEGER)`,
    );
    db.prepare(
      "INSERT INTO sessions (id, prompt_tokens, completion_tokens, cost, updated_at) VALUES (?,?,?,?,?)",
    ).run("s-1", 1000, 200, 0.05, 1786373253);
    db.prepare(
      "INSERT INTO sessions (id, prompt_tokens, completion_tokens, cost, updated_at) VALUES (?,?,?,?,?)",
    ).run("s-2", 0, 0, 0, 1786373253);
    db.prepare(
      "INSERT INTO messages (session_id, model, created_at) VALUES (?,?,?)",
    ).run("s-1", "", 1786373250);
    db.prepare(
      "INSERT INTO messages (session_id, model, created_at) VALUES (?,?,?)",
    ).run("s-1", "deepseek-v4-flash", 1786373252);
  });
  try {
    const records = readCrushRecords(path, 0);
    assert(records !== null);
    assertEquals(records.length, 1);
    assertEquals(records[0].provider, "crush");
    assertEquals(records[0].sessionId, "s-1");
    assertEquals(records[0].model, "deepseek-v4-flash");
    assertEquals(records[0].timestampMs, 1786373253000);
    assertEquals(records[0].totals, {
      uncachedInputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 200,
      reasoningTokens: 0,
    });
    assertEquals(records[0].reportedCostUsd, 0.05);
  } finally {
    Deno.removeSync(path);
  }
});

Deno.test("crush - splits a mixed-model session across the models used", () => {
  const path = withTempDb((db) => {
    db.exec(
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, prompt_tokens INTEGER,
         completion_tokens INTEGER, cost REAL, updated_at INTEGER);
       CREATE TABLE messages (session_id TEXT, model TEXT, created_at INTEGER)`,
    );
    db.prepare(
      "INSERT INTO sessions (id, prompt_tokens, completion_tokens, cost, updated_at) VALUES (?,?,?,?,?)",
    ).run("s-mix", 1000, 200, 0.1, 1786373253);
    for (let i = 0; i < 3; i += 1) {
      db.prepare(
        "INSERT INTO messages (session_id, model, created_at) VALUES (?,?,?)",
      ).run("s-mix", "openai/gpt-5.6-luna", 1786373250 + i);
    }
    db.prepare(
      "INSERT INTO messages (session_id, model, created_at) VALUES (?,?,?)",
    ).run("s-mix", "deepseek-v4-flash", 1786373252);
  });
  try {
    const records = readCrushRecords(path, 0);
    assert(records !== null);
    assertEquals(records.length, 2);
    const byModel = Object.fromEntries(
      records.map((r) => [r.model, r]),
    );
    const luna = byModel["openai/gpt-5.6-luna"];
    const deepseek = byModel["deepseek-v4-flash"];
    assert(luna !== undefined && deepseek !== undefined);
    // 3 of 4 assistant messages are luna, 1 is deepseek.
    assertEquals(luna.totals, {
      uncachedInputTokens: 750,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 150,
      reasoningTokens: 0,
    });
    assertEquals(deepseek.totals, {
      uncachedInputTokens: 250,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
      reasoningTokens: 0,
    });
    assertEquals(luna.reportedCostUsd, 0.075);
    assertEquals(deepseek.reportedCostUsd, 0.025);
    // The split keeps both parts in one session and must not collide.
    assertEquals(luna.sessionId, "s-mix");
    assertEquals(deepseek.sessionId, "s-mix");
    assertEquals(luna.dedupeKey, "session:s-mix:openai/gpt-5.6-luna");
    assertEquals(deepseek.dedupeKey, "session:s-mix:deepseek-v4-flash");
  } finally {
    Deno.removeSync(path);
  }
});

Deno.test("crush - discovers per-project databases under scan roots", () => {
  const root = Deno.makeTempDirSync();
  try {
    const write = (path: string, bytes: string) => {
      Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      Deno.writeTextFileSync(path, bytes);
    };
    write(root + "/project-a/.crush/crush.db", "sqlite");
    write(root + "/project-b/.crush/crush.db", "sqlite");
    write(root + "/nested/proj/c/.crush/crush.db", "sqlite");
    Deno.mkdirSync(root + "/empty/.crush", { recursive: true });
    write(root + "/node_modules/fake/.crush/crush.db", "sqlite");

    const found = findCrushDatabases([root], 5);
    assertEquals(found.length, 3);
    assertEquals(found.includes(root + "/project-a/.crush/crush.db"), true);
    assertEquals(found.includes(root + "/nested/proj/c/.crush/crush.db"), true);
    // node_modules is pruned and the empty .crush has no database.
    assertEquals(
      found.includes(root + "/node_modules/fake/.crush/crush.db"),
      false,
    );

    // Respects maxDepth: the deep one is out of reach at depth 2.
    const shallow = findCrushDatabases([root], 2);
    assertEquals(shallow.length, 2);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("sqliteFingerprint - covers the -wal and -shm companion files", () => {
  const path = withTempDb((db) => db.exec("CREATE TABLE t (x INTEGER)"));
  try {
    const before = sqliteFingerprint(path);
    assert(before !== null);
    // WAL and SHM files may already exist; writing to one must move the
    // fingerprint so the scan cache does not serve stale records.
    Deno.writeFileSync(path + "-wal", new Uint8Array(64), { append: true });
    const after = sqliteFingerprint(path);
    assert(after !== null);
    assertEquals(after.size, before.size + 64);
    assert(
      after.mtimeMs >= before.mtimeMs,
      "fingerprint mtime should not go backwards",
    );
  } finally {
    Deno.removeSync(path);
    try {
      Deno.removeSync(path + "-wal");
    } catch {
      // Already gone.
    }
  }
});

Deno.test("recordsForSource - a failed re-read reuses the last good snapshot", async () => {
  const path = withTempDb((db) => {
    db.exec(
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, prompt_tokens INTEGER,
         completion_tokens INTEGER, cost REAL, updated_at INTEGER)`,
    );
    db.prepare(
      "INSERT INTO sessions (id, prompt_tokens, completion_tokens, cost, updated_at) VALUES (?,?,?,?,?)",
    ).run("s-1", 1000, 200, 0.05, 1786373253);
  });
  try {
    const cache = new Map();
    const stats = Deno.statSync(path);
    const first = await recordsForSource(
      path,
      "crush",
      stats.size,
      stats.mtime!.getTime(),
      cache,
      0,
    );
    assert(first !== null);
    assertEquals(first.length, 1);

    // Drop the database: the next read fails, but the report must still carry
    // the previous snapshot instead of silently losing the whole store.
    Deno.removeSync(path);
    const second = await recordsForSource(
      path,
      "crush",
      999,
      999,
      cache,
      0,
    );
    assert(second !== null);
    assertEquals(second.length, 1);
    assertEquals(second[0].sessionId, "s-1");
  } finally {
    try {
      Deno.removeSync(path);
    } catch {
      // Already gone.
    }
  }
});
