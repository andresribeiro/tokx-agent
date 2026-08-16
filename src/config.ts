import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentConfig {
  readonly token: string;
  readonly backendUrl: string;
  readonly claudeProjectsDir: string;
  readonly codexSessionsDir: string;
  readonly opencodeDbPath: string;
  readonly crushDbPath: string | null;
  readonly crushScanRoots: readonly string[];
  readonly crushScanDepth: number;
  readonly stateDir: string;
  readonly windowDays: number;
  readonly intervalSeconds: number;
  readonly timeZone: string;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required (see agent/README.md)`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = Deno.env.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function parseCliArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && arg.length > 2) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        result[arg.slice(2)] = value;
        i += 1;
      }
    }
  }
  return result;
}

export function loadConfig(): AgentConfig {
  const home = homedir();
  const cli = parseCliArgs(Deno.args);
  const timeZone = Deno.env.get("TZ") ||
    (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");

  const claudeHome = Deno.env.get("CLAUDE_HOME") ?? home;
  const explicitClaudeDir = Deno.env.get("CLAUDE_PROJECTS_DIR");
  const codexHome = Deno.env.get("CODEX_HOME") ?? home;
  const explicitCodexDir = Deno.env.get("CODEX_SESSIONS_DIR");
  const xdgDataHome = Deno.env.get("XDG_DATA_HOME") ??
    join(home, ".local", "share");
  const crushScanRoot = Deno.env.get("CRUSH_SCAN_ROOT") ?? home;

  let claudeProjectsDir = explicitClaudeDir ??
    join(claudeHome, ".claude", "projects");
  if (explicitClaudeDir === undefined) {
    try {
      Deno.statSync(claudeProjectsDir);
    } catch {
      claudeProjectsDir = join(claudeHome, "projects");
    }
  }

  return {
    token: cli.token ?? requireEnv("TOKEN"),
    backendUrl: Deno.env.get("BACKEND_URL") ?? "http://localhost:3333",
    claudeProjectsDir,
    codexSessionsDir: explicitCodexDir ?? join(codexHome, ".codex", "sessions"),
    opencodeDbPath: Deno.env.get("OPENCODE_DB_PATH") ??
      join(xdgDataHome, "opencode", "opencode.db"),
    crushDbPath: Deno.env.get("CRUSH_DB_PATH") ?? null,
    crushScanRoots: crushScanRoot.split(":").filter((root) => root.length > 0),
    crushScanDepth: intEnv("CRUSH_SCAN_DEPTH", 5),
    stateDir: Deno.env.get("STATE_DIR") ?? join(home, ".tokenmaxxing", "agent"),
    windowDays: intEnv("WINDOW_DAYS", 30),
    intervalSeconds: intEnv("INTERVAL_SECONDS", 0),
    timeZone,
  };
}
