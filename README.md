# dsh-keyless-search

**English** | [Bahasa Indonesia](README.id.md)

**Web search for DeepSeek Harness that works without an API key.**

A DSH bundle that registers a `web_search` backend for the `ctx.web` seam using
hosted MCP services that accept unauthenticated requests — the same approach the
OpenCode CLI takes for its `websearch` tool. No sign-up, no key, no credit card.

Works on **Windows, macOS, and Linux**.

---

## Why it needs no API key

Both backends are public hosted MCP endpoints that answer `tools/call` without
authentication:

| Backend | Endpoint | Tool | Role |
|---|---|---|---|
| Exa | `https://mcp.exa.ai/mcp` | `web_search_exa` | primary |
| Parallel | `https://mcp.parallel.ai/mcp` | `web_search` | fallback |

No credential is read, stored, or transmitted. The plugin calls the endpoint
directly and parses the returned sources.

> These are third-party public services. Their limits and availability can change
> without notice — that is exactly why the plugin ships a fallback chain instead
> of a single backend.

---

## Install

```bash
dsh plugin --profile <your-profile> add dsh-keyless-search
```

Replace `<your-profile>` with your profile name (`web`, `tui`, `superagent`, …).

That registers the package as a bundle in your profile's `package.json` and
applies its patch. Restart DSH afterwards.

### Install from a local checkout

```bash
dsh plugin --profile <your-profile> add /absolute/path/to/dsh-keyless-search
```

On Windows use a full path such as `C:\src\dsh-keyless-search`.

### Verify

```bash
dsh --profile <your-profile> --dump-config | grep -E "keyless|searchProvider"
```

On Windows, use `Select-String` instead of `grep`:

```powershell
dsh --profile <your-profile> --dump-config | Select-String "keyless|searchProvider"
```

You should see the `keyless-search` entry and `searchProvider: keyless-mcp`
patching the `web` row. Then ask the agent to search for something current, or
call the `web_search` tool directly.

---

## How it works

The plugin registers a provider named `keyless-mcp` on the `ctx.web` seam. When
the model calls `web_search`:

1. Backends are tried in order — **Exa** first, then **Parallel**.
2. The first backend that returns sources wins.
3. A backend that fails or returns nothing is skipped and logged as a warning.
4. If every backend fails, a `WEB_PROVIDER_ERROR` is raised carrying each
   backend's reason.

Both backends are called **statelessly** — no `initialize` handshake and no
session id — so one search is one HTTP request.

---

## Configuration

Defaults are baked in and work out of the box. To override, edit the `config`
block in the installed `cordis.patch.yml`, or copy the bundle's patch into your
profile patch.

| Field | Default | Meaning |
|---|---|---|
| `backends` | `[exa, parallel]` | Backend order; the first that answers wins |
| `timeoutMs` | `45000` | Per-search timeout for one backend, in milliseconds |
| `maxResults` | `10` | Upper bound on sources requested per backend |

The seam still enforces the caller's own `maxResults`, so a lower value from
`dsh-tool-web` always wins.

Example — Parallel only, longer timeout:

```yaml
- insert:
    - id: keyless-search
      name: 'dsh-keyless-search'
      config:
        backends:
          - parallel
        timeoutMs: 60000
```

---

## Cross-platform notes

The plugin is deliberately dependency-free and path-free so it behaves
identically on every OS:

- **No imports.** `lib/index.js` imports nothing, so it resolves from any profile
  directory without an install step or a matching dependency tree.
- **No path handling.** No `node:path`, no separators, no shell — nothing that
  differs between Windows and POSIX.
- **Web-standard globals only.** `fetch`, `AbortSignal`, `URL`, `TextDecoder`, and
  `AbortController`, all provided by Node itself.
- **Feature detection.** `AbortSignal.any` and `AbortSignal.timeout` are used when
  present and replaced by a manual controller with a timer otherwise, so older
  Node builds still work.
- **No native modules.** Nothing to compile, so no build tools are needed on
  Windows.

Tested on Linux with Node 24. Installation goes through `dsh plugin add`, which
follows the same command path on Windows and macOS, with no platform-specific
steps.

---

## Removing

```bash
dsh plugin --profile <your-profile> remove dsh-keyless-search
```

Search then falls back to whatever provider your profile selected before
(`deepseek-official` by default, which needs `DEEPSEEK_API_KEY`).

---

## Troubleshooting

**`WEB_PROVIDER_AMBIGUOUS` on fetch.** The `web` row's `config` block is replaced
by this bundle's patch. If you override that row yourself, you must restate
`fetchProvider: http`, otherwise two fetch providers stay registered
(`deepseek-fetch-api` and `http`) and the seam refuses to choose.

**`WEB_PROVIDER_AMBIGUOUS` on search.** Another search provider is registered and
`searchProvider` is unset. This bundle pins `searchProvider: keyless-mcp`, so this
only happens if you removed that line.

**Every backend fails.** Check network egress to `mcp.exa.ai` and
`mcp.parallel.ai`. Corporate proxies and firewalls are the usual cause.

**No results but no error.** A partial result is returned when at least one
backend answers. The plugin raises an error only when every backend returns
nothing or fails.

---

## License

MIT — see [LICENSE](LICENSE).
