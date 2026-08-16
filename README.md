# Tokx usage agent

Reads your local Claude Code, Codex, OpenCode, and Crush session data (the same
files the t3code cost screen reads), aggregates it into daily
`(provider, model)` usage buckets, and uploads them to a Tokx server, which
prices them against the LiteLLM rate table.

The scan mirrors the t3code usage pipeline:

- Claude Code: `~/.claude/projects/**/*.jsonl`, parsed from `assistant` lines'
  `message.usage`, de-duplicated by `message.id:requestId`.
- Codex: `~/.codex/sessions/**/*.jsonl`, parsed from `token_count` events'
  `last_token_usage`, with fork/subagent copy suppression and consecutive
  duplicate suppression.
- OpenCode: the SQLite store at `~/.local/share/opencode/opencode.db`
  (`$XDG_DATA_HOME/opencode/opencode.db`). Per-message usage is read from the
  `message` and `session_message` tables; sessions without message-level rows
  fall back to the totals on `session_v2`/`session`, so nothing is
  double-counted across the two storage layouts.
- Crush: one SQLite store per project (a `.crush/crush.db` in each working
  directory, falling back to `~/.crush`); the agent discovers them under your
  home directory (or `CRUSH_SCAN_ROOT`). Sessions only track aggregate
  prompt/completion tokens plus a provider-reported cost; the model is taken
  from the session's most recent assistant message, if any.
- Cost: the agent never prices usage itself. Buckets whose records carry a
  provider-reported cost send that sum (`cost_usd`); everything else sends
  `cost_usd: null` and is priced by the server against the LiteLLM rate table.
  The server also computes cache savings (the difference between full and
  discounted cache-read rates) and applies the fixed 92% cache-hit split to
  Crush sessions, whose store merges cached and uncached input.
- A per-file `(size, mtime)` scan cache makes repeat scans nearly free.

## Configuration

| Env var               | Default                                                   | Description                                                             |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `TOKEN`               | required (or `--token` flag)                              | Your personal usage ingest key from the web app                         |
| `BACKEND_URL`         | `http://localhost:3333`                                   | Base URL of the Tokx server                                             |
| `CLAUDE_PROJECTS_DIR` | `$HOME/.claude/projects` (falls back to `$HOME/projects`) | Claude transcript directory                                             |
| `CODEX_SESSIONS_DIR`  | `$HOME/.codex/sessions`                                   | Codex transcript directory                                              |
| `OPENCODE_DB_PATH`    | `$XDG_DATA_HOME/opencode/opencode.db`                     | OpenCode SQLite store                                                   |
| `CRUSH_DB_PATH`       | (unset)                                                   | A single Crush SQLite store to read instead of discovering them         |
| `CRUSH_SCAN_ROOT`     | `$HOME`                                                   | Colon-separated roots searched for per-project `.crush/crush.db` stores |
| `CRUSH_SCAN_DEPTH`    | `5`                                                       | Max directory depth for the Crush store search                          |
| `STATE_DIR`           | `$HOME/.tokx/agent`                                       | Where the scan cache lives                                              |
| `WINDOW_DAYS`         | `30`                                                      | How many days of usage to scan and upload                               |
| `INTERVAL_SECONDS`    | `0`                                                       | If > 0, rescan on this interval instead of exiting                      |
| `TZ`                  | system zone                                               | IANA timezone days are bucketed in                                      |

The token identifies your account, so the agent no longer needs a separate user
id. Get your key from the web app (Usage page → _Usage ingest key_); it is shown
only once and can be rotated there. Uploads with an unknown token are rejected
with 401.

## Docker

```bash
docker build -t tokx-agent .

docker run -d --name tokx --restart always \
  --user "$(id -u):$(id -g)" \
  --memory=1g \
  -v "$HOME:/home/deno:ro" \
  -v "$HOME/.tokx/agent:/state" \
  -e BACKEND_URL=http://localhost:3333 \
  -e INTERVAL_SECONDS=3600 \
  ghcr.io/andresribeiro/tokx-agent:latest \
  --token your-ingest-key
```

or pass the token via env instead of the `--token` flag:

```bash
docker run -d --name tokx --restart always \
  --user "$(id -u):$(id -g)" \
  --memory=1g \
  -v "$HOME:/home/deno:ro" \
  -v "$HOME/.tokx/agent:/state" \
  -e TOKEN=your-ingest-key \
  -e BACKEND_URL=http://localhost:3333 \
  -e INTERVAL_SECONDS=3600 \
  ghcr.io/andresribeiro/tokx-agent:latest
```

- `--user "$(id -u):$(id -g)"` matches the container process to your host uid so
  the transcripts (often `0600`) and SQLite stores are readable.
- `--memory` is required for stability: the distroless image sets
  `DENO_USE_CGROUPS=1`, so Deno sizes its V8 heap from the cgroup memory limit.
  Without a limit it uses the whole host's memory as its heap budget, which can
  crash Deno's GC threads during a fresh scan; `--memory=1g` keeps the heap
  sane.
- The `$HOME` mount is read-only and covers everything the agent reads (Claude
  and Codex transcripts, the OpenCode store, and per-project `.crush` dirs);
  only `STATE_DIR` needs to be writable. Prefer mounting just the provider
  directories (`.claude`, `.codex`, `.local/share/opencode`, `.crush`) if you
  don't want the container to have read access to your whole home directory.
- On macOS/Windows Docker Desktop, use `http://host.docker.internal:3333` as
  `BACKEND_URL`. On Linux with `--network host` (or a server reachable on your
  LAN), plain `localhost` works.
- With `INTERVAL_SECONDS` set, run it as a long-lived container; with it unset,
  invoke it from cron/systemd (swap `--restart always` for `--rm`).

Each run uploads the full window; the server replaces the user's rows in that
window, so stale or deleted transcripts do not leave ghost entries behind.

## Local run (no Docker)

```bash
deno task run -- --token your-ingest-key   # or TOKEN=... deno task run
```

## Tests

```bash
deno test
```

## Origin

This repository is a public mirror of the `agent/` directory in the private
[tokx monorepo](https://github.com/andresribeiro/tokx). It is published so the
agent can be pulled as a container image and inspected; development happens in
the monorepo and changes are synced out periodically.
