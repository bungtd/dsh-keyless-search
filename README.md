# dsh-keyless-search

**English** | [Bahasa Indonesia](README.id.md)

**Web search for DeepSeek Harness that works without an API key.**

A DSH bundle that registers a `web_search` backend for the `ctx.web` seam. It
chains several independent public backends and returns the first one that
produces sources, so a single endpoint going down or rate-limiting does not
break search. No sign-up, no key, no credit card.

Works on **Windows, macOS, and Linux**.

## Quick start

```bash
dsh plugin --profile <your-profile> add github:bungtd/dsh-keyless-search
# restart DSH, then ask it to search for something current
```

Already on v1 (Exa + Parallel only)? That chain stopped working — run the same
command to upgrade, then restart. See [Install](#install) for version pinning and
[Verify](#verify) to confirm it took effect.

---

## Why it needs no API key

Every backend is a public endpoint that answers unauthenticated requests — no
credential is read, stored, or transmitted.

| Backend | Endpoint | Transport | Role |
|---|---|---|---|
| WebCrawler | `webcrawler.com/search/web` | HTML | general |
| Mwmbl | `api.mwmbl.org/search` | JSON | general |
| Lumy | `search.lumy.live/search?format=json` | JSON (SearXNG) | general |
| Wikipedia | `en.wikipedia.org/w/api.php` | JSON | specialist |
| Hacker News | `hn.algolia.com/api/v1/search` | JSON | specialist |
| TinyFish | `agent.tinyfish.ai/mcp` | MCP JSON-RPC | general (guest tier) |
| Exa | `mcp.exa.ai/mcp` | MCP JSON-RPC | general |
| Parallel | `mcp.parallel.ai/mcp` | MCP JSON-RPC | general |

Optional backends, not in the default chain — add the ones you want to
`backends`:

| Backend | Endpoint | Transport | Best for |
|---|---|---|---|
| MDN | `developer.mozilla.org/api/v1/search` | JSON | web platform / browser APIs |
| npm | `registry.npmjs.org/-/v1/search` | JSON | packages |
| arXiv | `export.arxiv.org/api/query` | Atom XML | papers |
| Google News | `news.google.com/rss/search` | RSS | recent news |

> These are third-party public services. Their limits and availability can
> change without notice — that is exactly why the plugin ships a backend chain
> instead of a single backend, and why failures are handled gracefully.

**TinyFish** is the one backend with a hard quota rather than a rate limit: its
anonymous guest tier allows **50 searches per day per network** (shared by every
machine behind the same IP) plus 30 requests per minute. That is why it sits
late in the chain — the backends before it need no quota at all. A free TinyFish
account raises the cap to 12,000/day, but that needs a key and is therefore out
of scope for this bundle.

---

## Install

One command, run in your own terminal:

```bash
dsh plugin --profile <your-profile> add github:bungtd/dsh-keyless-search
```

Replace `<your-profile>` with the profile you actually boot (`web`, `tui`,
`superagent`, …). If the profile does not exist yet, the command creates it.

That registers the bundle in your profile's `package.json` and applies its patch.
**Restart DSH afterwards** so the new search provider is mounted.

> **Use the full `github:` URL.** This package is not published to npm, and the
> npm name `dsh-keyless-search` belongs to an unrelated project — running
> `add dsh-keyless-search` installs *that* package instead, which is not this
> plugin.

### Pin a version

`main` is the development branch; pin a release tag for reproducible installs:

```bash
dsh plugin --profile <your-profile> add github:bungtd/dsh-keyless-search#v2.0.0
```

### Install from a local checkout

```bash
git clone https://github.com/bungtd/dsh-keyless-search.git
dsh plugin --profile <your-profile> add /absolute/path/to/dsh-keyless-search
```

On Windows use the full path, e.g. `C:\src\dsh-keyless-search`.

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

1. Backends are tried in the configured order — general engines first, then the
   quota-free specialist backends.
2. The first backend that returns sources wins.
3. A backend that fails is skipped, logged as a warning, and put on **cooldown**.
4. If every backend fails, a `WEB_PROVIDER_ERROR` is raised carrying each
   backend's reason.

Every backend is called **statelessly** — one search is one HTTP request, with
no `initialize` handshake and no session id.

### Cooldown

A failing backend is not retried on every subsequent search. The first failure
parks it for 60 seconds, and each consecutive failure doubles that window up to
15 minutes. A backend that answers again is taken off cooldown immediately.

When the server states its own wait, that figure is used instead — an HTTP
`Retry-After` header, or a reset instant embedded in a quota message. TinyFish's
guest tier reports its daily-exhaustion time this way, so it goes quiet until the
real reset rather than being retried every 15 minutes.

This matters because public endpoints fail in bursts: a blocked engine would
otherwise add its timeout to *every* search the user makes.

---

## Configuration

Defaults are baked in and work out of the box. To override, edit the `config`
block in the installed `cordis.patch.yml`, or copy the bundle's patch into your
profile patch.

| Field | Default | Meaning |
|---|---|---|
| `backends` | `[webcrawler, mwmbl, lumy, wikipedia, hackernews, tinyfish, exa, parallel]` | Backend order; the first that answers wins |
| `timeoutMs` | `20000` | Per-search timeout for one backend, in milliseconds |
| `maxResults` | `10` | Upper bound on sources requested per backend |

The seam still enforces the caller's own `maxResults`, so a lower value from
`dsh-tool-web` always wins.

Example — only the always-available specialist backends, longer timeout:

```yaml
- insert:
    - id: keyless-search
      name: 'dsh-keyless-search'
      config:
        backends:
          - wikipedia
          - hackernews
        timeoutMs: 60000
```

Example — add the topic-specific sources to the chain:

```yaml
- insert:
    - id: keyless-search
      name: 'dsh-keyless-search'
      config:
        backends:
          - webcrawler
          - mwmbl
          - mdn
          - npm
          - arxiv
```

Unknown backend names are dropped with a warning; an empty resulting list falls
back to the default chain.

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

## Development

```bash
npm test          # parser + provider tests, no network
npm run test:live # opt-in smoke test against the real public backends
```

`npm test` is hermetic: it feeds recorded response shapes through every parser
and exercises backend chaining, cooldowns, and cancellation with fake backends.

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

**Every backend fails.** Check network egress to the hosts in the table above.
Corporate proxies and firewalls are the usual cause. The raised error names every
backend's individual reason, so start there.

**No results but no error.** A partial result is returned when at least one
backend answers. The plugin raises an error only when every backend returns
nothing or fails.

**Searches suddenly take longer.** A backend has probably started failing and is
being retried through its first cooldown. The structured warning line
(`keyless_search_backend_failed`) names it.

**A backend keeps getting skipped.** Its cooldown may have grown to several
minutes after repeated failures. Restarting DSH clears the cooldowns.

---

## License

MIT — see [LICENSE](LICENSE).
