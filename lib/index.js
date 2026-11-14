/**
 * Keyless web search for the DeepSeek Harness web seam (`ctx.web`).
 *
 * Registers one search provider that needs **no API key at all**. It chains
 * several independent public backends and returns the first one that produces
 * sources, so a single backend going down or rate-limiting does not break search.
 *
 * Backends (all answer unauthenticated)
 * ─────────────────────────────────────
 * Listed in default chain order, then the optional ones.
 *
 *   webcrawler → https://www.webcrawler.com/search/web        (HTML, general)
 *   mwmbl      → https://api.mwmbl.org/search                 (JSON, general)
 *   lumy       → https://search.lumy.live/search              (JSON, general)
 *   wikipedia  → https://en.wikipedia.org/w/api.php           (JSON, specialist)
 *   hackernews → https://hn.algolia.com/api/v1/search         (JSON, specialist)
 *   tinyfish   → https://agent.tinyfish.ai/mcp                (MCP JSON-RPC, guest tier)
 *   exa        → https://mcp.exa.ai/mcp                       (MCP JSON-RPC, general)
 *   parallel   → https://mcp.parallel.ai/mcp                  (MCP JSON-RPC, general)
 *   mdn        → https://developer.mozilla.org/api/v1/search  (JSON, web platform)
 *   npm        → https://registry.npmjs.org/-/v1/search       (JSON, packages)
 *   arxiv      → https://export.arxiv.org/api/query           (Atom XML, papers)
 *   googlenews → https://news.google.com/rss/search           (RSS, news)
 *
 * Nothing here reads, stores, or sends a credential.
 *
 * Design notes
 * ────────────
 * • **No imports.** This module imports nothing, so it resolves from any profile
 *   directory on any OS without an install step or a matching dependency tree.
 * • **No cordis `Config`.** A plain-object schema leaves the plugin fiber stuck
 *   and `apply` never runs; `schemastery` would add a module-resolution
 *   dependency. Without `Config`, cordis hands `apply` the raw config object, so
 *   every default is resolved here instead.
 * • **Cross-platform.** Only web-standard globals (`fetch`, `AbortSignal`,
 *   `URL`, `TextDecoder`) are used, plus feature detection instead of assuming
 *   `AbortSignal.any`/`AbortSignal.timeout` exist. Paths are never touched, so
 *   Windows, macOS, and Linux behave identically.
 * • **Rate-limit aware.** A backend that fails is put on an exponential cooldown
 *   so one dead endpoint cannot slow down every subsequent search.
 *
 * @module dsh-keyless-search
 */

/** Stable provider id the seam stores this provider under (kept for compat). */
const PROVIDER_ID = "keyless-mcp";

/** Machine-routable failure codes, matching the seam's WebError vocabulary. */
const CODE_ABORTED = "WEB_ABORTED";
const CODE_PROVIDER = "WEB_PROVIDER_ERROR";
const CODE_TIMEOUT = "WEB_SEARCH_TIMEOUT";
const CODE_RATE_LIMITED = "WEB_RATE_LIMITED";

/** Version banner, also used by the hosted servers to attribute traffic. */
const VERSION = "2.0.0";
const USER_AGENT = `dsh-keyless-search/${VERSION} (+https://github.com/temanio/dsh-keyless-search)`;

/**
 * Browser-shaped UA. Several public search front-ends serve a bot challenge
 * instead of results unless the request looks like a real browser, so the HTML
 * backends send this. JSON APIs keep the descriptive {@link USER_AGENT}.
 */
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Defaults, mirrored in the README and the bundle patch. */
/*
 * Order is a snapshot of measured health, not a permanent ranking — public
 * endpoints drift. Ranked 2026-11-14 by `node scripts/probe.mjs`:
 *
 *   mwmbl       healthy   ~760ms   (now the fastest reliable general engine)
 *   exa         healthy   ~690ms   (recovered after a multi-day 429 block)
 *   parallel    healthy  ~1160ms
 *   wikipedia   healthy   ~870ms   (quota-free)
 *   tinyfish    healthy  ~3600ms   (guest tier: 50 searches/day per network)
 *   hackernews  degraded ~860ms    (some queries legitimately have no hits)
 *   lumy        degraded  9–22s    (a meta-searcher; slow and inconsistent)
 *   webcrawler  down     403       (IP-blocked; kept last in case it lifts)
 *
 * Re-run the probe before trusting this list, and move anything that recovered
 * ahead of anything that broke. `exa` and `webcrawler` swapped places within 17
 * hours once, which is exactly why the order is data rather than opinion.
 */
const DEFAULT_BACKENDS = ["mwmbl", "exa", "parallel", "wikipedia", "tinyfish", "hackernews", "lumy", "webcrawler"];
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 10;

/** Cooldown applied to a backend after a failure; doubles per consecutive strike. */
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

/**
 * Ceiling for a wait the *server itself* asked for (`Retry-After`, or a reset
 * instant embedded in a quota error). That is an exact figure, so honouring it
 * fully avoids pointless retries; only absurd values get clipped.
 */
const MAX_ADVERTISED_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Minimal WebError stand-in: the seam and tool layer only read `code`,
 * `message`, and `cause`, so duck-typing it keeps this plugin import-free.
 */
class SearchError extends Error {
	/**
	 * @param {string} message - human-readable failure text.
	 * @param {string} code - machine-routable WebError code.
	 * @param {{ cause?: unknown }} [options] - optional chained cause.
	 */
	constructor(message, code, options = {}) {
		super(message, options);
		this.name = "WebError";
		this.code = code;
	}
}

// ── Text helpers ─────────────────────────────────────────────────────────────

/** The handful of HTML entities worth decoding without a parser. */
const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	middot: "·",
	bull: "•",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	euro: "€",
	pound: "£",
	yen: "¥",
};

/**
 * Decode numeric and the common named HTML entities. `&amp;` is decoded in the
 * same pass, which is safe because a single pass never re-reads its own output.
 * @param {string} text - text that may contain entities.
 * @returns {string} decoded text.
 */
function decodeEntities(text) {
	if (typeof text !== "string" || !text.includes("&")) return text;
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (match, entity) => {
		if (entity.startsWith("#")) {
			const hex = entity[1] === "x" || entity[1] === "X";
			const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
			if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		const named = NAMED_ENTITIES[entity];
		return named === undefined ? match : named;
	});
}

/** Strip tags and decode entities, collapsing runs of whitespace. */
function stripHtml(html) {
	if (typeof html !== "string" || html === "") return "";
	return decodeEntities(html.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
}

/**
 * Strip only inline highlight markup (`<span class="searchmatch">` and friends),
 * keeping the surrounding text glued together. Wikipedia snippets split a single
 * word across a highlight boundary — `the <span>lang</span>uage` must read
 * "the language", not "the lang uage" — so a plain tag-to-space strip corrupts
 * them. Any remaining block-level tag is still replaced by a space.
 */
function stripInlineMarkup(html) {
	if (typeof html !== "string" || html === "") return "";
	const glued = html.replace(/<\/?(?:span|b|strong|em|i|mark|u|small|big|code)\b[^>]*>/giu, "");
	return stripHtml(glued);
}

/** Trim and cap a snippet so one long page cannot flood the model's context. */
function snippetOf(text) {
	if (typeof text !== "string") return undefined;
	const clean = text.replace(/\s+/gu, " ").trim();
	if (clean === "") return undefined;
	return clean.length > 800 ? `${clean.slice(0, 800)}…` : clean;
}

/** Clamp a requested result count into the supported range. */
function clampResults(value, fallback) {
	const n = Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.max(1, Math.min(n, 100));
}

/** Reject anything that is not an absolute http(s) URL. */
function isHttpUrl(url) {
	return typeof url === "string" && /^https?:\/\//u.test(url);
}

/** Words that carry no distinguishing signal in a search request. */
const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from",
	"how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "not", "of", "on", "or", "so",
	"that", "the", "their", "then", "there", "these", "this", "to", "was", "were", "what", "when",
	"where", "which", "who", "why", "will", "with", "you", "your",
]);

/**
 * Reduce a free-text query to its few highest-signal terms.
 *
 * Several backends do strict AND matching over terms (Wikipedia's `srsearch`
 * most notably), where a raw conversational sentence returns zero hits while
 * its 2–4 keywords return plenty. Quoted phrases are preserved verbatim because
 * the caller asked for exactly that.
 * @param {string} query - the raw query.
 * @param {number} [limit] - maximum number of terms to keep.
 * @returns {string} a shortened query, or the original when nothing is left.
 */
function trimQuery(query, limit = 4) {
	const text = typeof query === "string" ? query.trim() : "";
	if (text === "") return text;
	const terms = [];
	for (const token of text.split(/\s+/u)) {
		if (token === "") continue;
		const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.+#-]+$/gu, "");
		if (bare === "") continue;
		const isPhrase = token.startsWith('"') || token.startsWith("'");
		if (!isPhrase && STOPWORDS.has(bare.toLowerCase())) continue;
		terms.push(token);
		if (terms.length >= limit) break;
	}
	return terms.length > 0 ? terms.join(" ") : text;
}

/**
 * Build a Wikipedia article URL from a title. Each path segment is encoded
 * separately so titles containing `/` keep their subpage shape.
 */
function wikipediaUrl(title) {
	const path = String(title).replace(/ /gu, "_");
	return `https://en.wikipedia.org/wiki/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * Build a cancellation signal that fires on the caller's abort or the timeout,
 * whichever comes first. Feature-detects `AbortSignal.any`/`AbortSignal.timeout`
 * so the plugin still runs on older Node builds; falls back to a manual
 * controller wired to a timer.
 * @param {AbortSignal | undefined} signal - the caller's signal, if any.
 * @param {number} timeoutMs - per-request timeout.
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
function withTimeout(signal, timeoutMs) {
	const anyOf = typeof AbortSignal?.any === "function";
	const timeoutOf = typeof AbortSignal?.timeout === "function";

	if (signal !== undefined && anyOf && timeoutOf) {
		return { signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]), cleanup: () => {} };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal !== undefined) {
		if (signal.aborted === true) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
		},
	};
}

/** True when an error came from a timeout rather than the caller aborting. */
function isTimeoutError(error, callerSignal) {
	if (callerSignal?.aborted === true) return false;
	if (error === null || typeof error !== "object") return false;
	if (error.name === "TimeoutError") return true;
	return error.name === "AbortError" || error.name === "Error";
}

/** HTTP statuses that mean "this backend is throttling or refusing us". */
function isThrottleStatus(status) {
	return status === 202 || status === 403 || status === 429 || status === 503;
}

/**
 * Perform one HTTP request with timeout, abort support, and a bounded body.
 * Never throws for a non-2xx response: the caller decides whether a status is
 * fatal, because every backend classifies them differently.
 * @param {string} url - absolute URL to request.
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string,
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   label: string,
 *   redirect?: 'follow' | 'error',
 * }} options - request options.
 * @returns {Promise<{ status: number, ok: boolean, text: string }>}
 */
async function requestText(url, options) {
	const { signal: composite, cleanup } = withTimeout(options.signal, options.timeoutMs);
	let response;
	try {
		response = await fetch(url, {
			method: options.method ?? "GET",
			redirect: options.redirect ?? "follow",
			headers: options.headers,
			...(options.body === undefined ? {} : { body: options.body }),
			signal: composite,
		});
	} catch (error) {
		if (options.signal?.aborted === true) {
			throw new SearchError(`${options.label} search aborted`, CODE_ABORTED, { cause: error });
		}
		if (isTimeoutError(error, options.signal)) {
			throw new SearchError(`${options.label} search timed out after ${options.timeoutMs}ms`, CODE_TIMEOUT, { cause: error });
		}
		throw new SearchError(`${options.label} search request failed: ${String(error?.message ?? error)}`, CODE_PROVIDER, { cause: error });
	} finally {
		cleanup();
	}

	const text = await response.text().catch(() => "");
	// A server that says when to come back knows better than any backoff we could
	// invent, so carry `Retry-After` (seconds or an HTTP date) up to the caller.
	return { status: response.status, ok: response.ok, text, retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) };
}

/**
 * Read an HTTP `Retry-After` header in milliseconds.
 * @param {string | null} value - the raw header, delta-seconds or an HTTP date.
 * @returns {number | undefined} the wait in ms, or `undefined` when absent/invalid.
 */
function parseRetryAfter(value) {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const trimmed = value.trim();
	if (/^\d+$/u.test(trimmed)) {
		return Math.min(Number(trimmed) * 1000, MAX_ADVERTISED_COOLDOWN_MS);
	}
	const at = Date.parse(trimmed);
	if (!Number.isFinite(at)) return undefined;
	return Math.min(Math.max(0, at - Date.now()), MAX_ADVERTISED_COOLDOWN_MS);
}

/**
 * Request text and require HTTP 200. Throttle statuses are surfaced as
 * {@link CODE_RATE_LIMITED} so the provider can put the backend on cooldown.
 */
async function requestOk(url, options) {
	const { status, ok, text, retryAfterMs } = await requestText(url, options);
	if (!ok) {
		const code = isThrottleStatus(status) ? CODE_RATE_LIMITED : CODE_PROVIDER;
		const error = new SearchError(`${options.label} search failed with HTTP ${status}: ${text.slice(0, 200)}`, code);
		if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
		throw error;
	}
	return text;
}

/** Request and JSON-parse, mapping a parse failure to a provider error. */
async function requestJson(url, options) {
	const text = await requestOk(url, options);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new SearchError(`${options.label} returned an unparseable response`, CODE_PROVIDER, { cause: error });
	}
}

/** Standard headers for the JSON/XML APIs (honest, descriptive UA). */
function apiHeaders(accept) {
	return { accept, "user-agent": USER_AGENT };
}

/** Standard headers for the HTML front-ends (browser-shaped UA). */
function browserHeaders(accept = "text/html,application/xhtml+xml") {
	return {
		accept,
		"accept-language": "en-US,en;q=0.9",
		"user-agent": BROWSER_USER_AGENT,
	};
}

// ── MCP JSON-RPC helpers (Exa / Parallel) ────────────────────────────────────

/**
 * Read an MCP response body: plain JSON, one SSE frame, or a multi-frame stream.
 * @param {string} body - the raw response text.
 * @returns {any} the JSON-RPC frame, or `undefined` when nothing parsed.
 */
function readMcpPayload(body) {
	const trimmed = body.trim();
	if (trimmed === "") return undefined;
	if (trimmed.startsWith("{")) return JSON.parse(trimmed);
	// SSE: `event: message` lines followed by `data: {...}`; prefer a frame that
	// carries a JSON-RPC result/error, since progress frames may come first.
	let fallback;
	for (const line of trimmed.split(/\r?\n/u)) {
		if (!line.startsWith("data:")) continue;
		const raw = line.slice(5).trim();
		if (raw === "" || raw === "[DONE]") continue;
		let frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			continue;
		}
		if (frame === null || typeof frame !== "object") continue;
		if ("result" in frame || "error" in frame) return frame;
		fallback ??= frame;
	}
	return fallback;
}

/** Extract the joined text blocks of one MCP `tools/call` result. */
function mcpText(result) {
	if (result === null || typeof result !== "object") return "";
	const content = Array.isArray(result.content) ? result.content : [];
	const parts = [];
	for (const item of content) {
		if (item !== null && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		}
	}
	return parts.join("\n\n");
}

/** Run one stateless `tools/call` against a hosted MCP endpoint. */
async function callMcp({ url, tool, args, signal, timeoutMs, label }) {
	// A rate-limit complaint from these servers arrives as HTTP 429 with a
	// JSON-RPC error body, which `requestOk` already classifies as
	// WEB_RATE_LIMITED, so the transport error needs no reinterpretation here.
	const text = await requestOk(url, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"user-agent": USER_AGENT,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
		signal,
		timeoutMs,
		label,
	});

	let payload;
	try {
		payload = readMcpPayload(text);
	} catch (error) {
		throw new SearchError(`${label} returned an unparseable response`, CODE_PROVIDER, { cause: error });
	}
	if (payload === undefined) throw new SearchError(`${label} returned an empty response`, CODE_PROVIDER);
	if (payload.error !== undefined && payload.error !== null) {
		const message =
			typeof payload.error === "object" && typeof payload.error.message === "string"
				? payload.error.message
				: JSON.stringify(payload.error);
		throw new SearchError(`${label} search error: ${message}`, CODE_PROVIDER);
	}
	const result = payload.result;
	if (result === null || typeof result !== "object") throw new SearchError(`${label} returned no result`, CODE_PROVIDER);
	if (result.isError === true) {
		throw new SearchError(`${label} search error: ${mcpText(result).slice(0, 300) || "unknown error"}`, CODE_PROVIDER);
	}
	return mcpText(result);
}

// ── Exa ──────────────────────────────────────────────────────────────────────

/**
 * Parse Exa's per-page blocks:
 *   Title: … / URL: … / Published: … / Author: … / Highlights: …
 * separated by `---` rules.
 * @param {string} text - the backend's text payload.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
function parseExaText(text) {
	const sources = [];
	if (typeof text !== "string" || text.trim() === "") return sources;
	for (const chunk of text.split(/\n-{3,}\s*(?:\n|$)/u)) {
		const urlMatch = /^URL:\s*(\S+)\s*$/mu.exec(chunk);
		if (urlMatch === null) continue;
		const url = urlMatch[1];
		if (!isHttpUrl(url)) continue;
		/** @type {{url: string, title?: string, snippet?: string, publishedAt?: string}} */
		const source = { url };
		const titleMatch = /^Title:\s*(.*)$/mu.exec(chunk);
		if (titleMatch !== null && titleMatch[1].trim() !== "") source.title = titleMatch[1].trim();
		const publishedMatch = /^Published:\s*(.*)$/mu.exec(chunk);
		if (publishedMatch !== null) {
			const published = publishedMatch[1].trim();
			if (published !== "" && published !== "N/A") source.publishedAt = published;
		}
		const highlightsMatch = /^Highlights:\s*\n?([\s\S]*)$/mu.exec(chunk);
		if (highlightsMatch !== null) {
			const snippet = snippetOf(highlightsMatch[1]);
			if (snippet !== undefined) source.snippet = snippet;
		}
		sources.push(source);
	}
	return sources;
}

async function searchExa(query, ctx) {
	const text = await callMcp({
		url: "https://mcp.exa.ai/mcp",
		tool: "web_search_exa",
		args: { query, numResults: ctx.maxResults },
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "Exa",
	});
	return parseExaText(text).slice(0, ctx.maxResults);
}

// ── Parallel ─────────────────────────────────────────────────────────────────

/**
 * Parse Parallel's answer: a JSON document first, markdown links after.
 * @param {string} text - the backend's text payload.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
function parseParallelText(text) {
	const sources = [];
	if (typeof text !== "string" || text.trim() === "") return sources;

	// Preferred shape: { search_id, results: [{ url, title, publish_date, excerpts }] }
	if (text.trimStart().startsWith("{")) {
		try {
			const doc = JSON.parse(text);
			const results = Array.isArray(doc?.results) ? doc.results : [];
			for (const item of results) {
				if (item === null || typeof item !== "object") continue;
				if (!isHttpUrl(item.url)) continue;
				/** @type {{url: string, title?: string, snippet?: string, publishedAt?: string}} */
				const source = { url: item.url };
				if (typeof item.title === "string" && item.title.trim() !== "") source.title = item.title.trim();
				if (typeof item.publish_date === "string" && item.publish_date.trim() !== "") source.publishedAt = item.publish_date.trim();
				const excerpts = Array.isArray(item.excerpts) ? item.excerpts.filter((e) => typeof e === "string") : [];
				if (excerpts.length > 0) {
					const snippet = snippetOf(excerpts.join(" "));
					if (snippet !== undefined) source.snippet = snippet;
				}
				sources.push(source);
			}
			return sources;
		} catch {
			/* not JSON after all — fall through to the markdown reader */
		}
	}

	// Markdown: `# [Title](url)` heading blocks, then any markdown link.
	for (const chunk of text.split(/\n(?=#\s)/u)) {
		const headingMatch = /^#\s*\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/mu.exec(chunk);
		if (headingMatch === null) continue;
		/** @type {{url: string, title?: string, snippet?: string}} */
		const source = { url: headingMatch[2] };
		if (headingMatch[1].trim() !== "") source.title = headingMatch[1].trim();
		const body = chunk.slice(headingMatch.index + headingMatch[0].length);
		const snippet = snippetOf(stripHtml(body));
		if (snippet !== undefined) source.snippet = snippet;
		sources.push(source);
	}
	if (sources.length > 0) return sources;

	const seen = new Set();
	for (const match of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gu)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		/** @type {{url: string, title?: string}} */
		const source = { url };
		if (match[1].trim() !== "") source.title = match[1].trim();
		sources.push(source);
	}
	return sources;
}

async function searchParallel(query, ctx) {
	const text = await callMcp({
		url: "https://mcp.parallel.ai/mcp",
		tool: "web_search",
		args: { objective: query, search_queries: [query] },
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "Parallel",
	});
	return parseParallelText(text).slice(0, ctx.maxResults);
}

// ── Lumy (SearXNG meta-search, JSON) ────────────────────────────────────────

/**
 * Parse a SearXNG `/search?...&format=json` payload.
 *
 * SearXNG aggregates several upstream engines and reports the ones it could not
 * reach under `unresponsive_engines`; those are ignored here because a partial
 * answer is still an answer.
 * @param {any} payload - parsed JSON.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
function parseSearxngJson(payload) {
	const results = payload?.results;
	if (!Array.isArray(results)) return [];
	const sources = [];
	for (const item of results) {
		if (item === null || typeof item !== "object" || !isHttpUrl(item.url)) continue;
		/** @type {{url: string, title?: string, snippet?: string, publishedAt?: string}} */
		const source = { url: item.url };
		const title = stripInlineMarkup(typeof item.title === "string" ? item.title : "");
		if (title !== "") source.title = title;
		const snippet = snippetOf(stripInlineMarkup(typeof item.content === "string" ? item.content : ""));
		if (snippet !== undefined) source.snippet = snippet;
		if (typeof item.publishedDate === "string" && item.publishedDate !== "") source.publishedAt = item.publishedDate;
		sources.push(source);
	}
	return sources;
}

async function searchLumy(query, ctx) {
	const url = `https://search.lumy.live/search?q=${encodeURIComponent(query)}&format=json`;
	const payload = await requestJson(url, {
		headers: apiHeaders("application/json"),
		signal: ctx.signal,
		// A meta-search fans out across upstream engines, so it is slower than a
		// direct API; give it more room than the configured per-backend timeout.
		timeoutMs: Math.max(ctx.timeoutMs, 25_000),
		label: "Lumy",
	});
	return parseSearxngJson(payload).slice(0, ctx.maxResults);
}

// ── TinyFish (keyless guest tier, MCP JSON-RPC) ──────────────────────────────

/**
 * Parse TinyFish's search payload.
 *
 * The tool result wraps its JSON in a text block, so the body is a string that
 * still has to be parsed. Results look like
 * `{ results: [{ url, title, snippet, site_name, date, position }] }`.
 * @param {unknown} payload - parsed JSON, or the raw text body.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
function parseTinyFishJson(payload) {
	let doc = payload;
	if (typeof payload === "string") {
		try {
			doc = JSON.parse(payload);
		} catch {
			return [];
		}
	}
	const results = doc?.results;
	if (!Array.isArray(results)) return [];
	const sources = [];
	for (const item of results) {
		if (item === null || typeof item !== "object" || !isHttpUrl(item.url)) continue;
		/** @type {{url: string, title?: string, snippet?: string, publishedAt?: string}} */
		const source = { url: item.url };
		const title = stripInlineMarkup(typeof item.title === "string" ? item.title : "");
		if (title !== "") source.title = title;
		const snippet = snippetOf(stripInlineMarkup(typeof item.snippet === "string" ? item.snippet : ""));
		if (snippet !== undefined) source.snippet = snippet;
		if (typeof item.date === "string" && item.date !== "") source.publishedAt = item.date;
		sources.push(source);
	}
	return sources;
}

/**
 * Read the wait time a quota-exhausted backend advertises in its error text.
 *
 * TinyFish reports exhaustion as HTTP 429 with a human-readable message that
 * embeds an exact reset instant, e.g. `"…used up (50/50) until
 * 2026-11-13T00:00:00.000Z"`. Honouring that is far better than a backoff guess:
 * the guest tier is 50 searches per day, so the right cooldown is hours, not
 * seconds. Returns `undefined` when no reset instant is present.
 * @param {string} message - the error body.
 * @returns {number | undefined} wait in ms.
 */
function quotaResetFrom(message) {
	if (typeof message !== "string") return undefined;
	const match = /until\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/u.exec(message);
	if (match === null) return undefined;
	const at = Date.parse(match[1]);
	if (!Number.isFinite(at)) return undefined;
	return Math.min(Math.max(0, at - Date.now()), MAX_ADVERTISED_COOLDOWN_MS);
}

async function searchTinyFish(query, ctx) {
	let text;
	try {
		text = await requestOk("https://agent.tinyfish.ai/mcp", {
			method: "POST",
			redirect: "error",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				// The guest tier is granted by this header; without it the endpoint
				// demands an OAuth bearer token.
				"x-tinyfish-access-mode": "keyless",
				"user-agent": USER_AGENT,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query } } }),
			signal: ctx.signal,
			timeoutMs: ctx.timeoutMs,
			label: "TinyFish",
		});
	} catch (error) {
		// A daily-quota exhaustion arrives as 429 too, but the useful cooldown is
		// the reset instant it names, not the short per-minute retry window.
		const reset = quotaResetFrom(error instanceof Error ? error.message : "");
		if (reset !== undefined) error.retryAfterMs = reset;
		throw error;
	}

	let payload;
	try {
		payload = readMcpPayload(text);
	} catch (error) {
		throw new SearchError("TinyFish returned an unparseable response", CODE_PROVIDER, { cause: error });
	}
	if (payload === undefined) throw new SearchError("TinyFish returned an empty response", CODE_PROVIDER);
	if (payload.error !== undefined && payload.error !== null) {
		const message =
			typeof payload.error === "object" && typeof payload.error.message === "string"
				? payload.error.message
				: JSON.stringify(payload.error);
		const error = new SearchError(`TinyFish search error: ${message}`, CODE_RATE_LIMITED);
		const reset = quotaResetFrom(message);
		if (reset !== undefined) error.retryAfterMs = reset;
		throw error;
	}
	const result = payload.result;
	if (result === null || typeof result !== "object") throw new SearchError("TinyFish returned no result", CODE_PROVIDER);
	if (result.isError === true) {
		throw new SearchError(`TinyFish search error: ${mcpText(result).slice(0, 300) || "unknown error"}`, CODE_PROVIDER);
	}
	const content = mcpText(result);
	return parseTinyFishJson(content).slice(0, ctx.maxResults);
}

// ── WebCrawler (System1 meta-search, HTML) ───────────────────────────────────

/**
 * Parse WebCrawler result blocks.
 *
 * Each result is one `<div class="web-yahoo__result">` holding
 * `<a class="web-yahoo__title" href="REAL_URL">Title</a>` plus an optional
 * `<span class="web-yahoo__description">Snippet</span>`. Splitting on the block
 * opener keeps this independent of attribute order and of surrounding markup.
 * @param {string} html - the search page.
 * @returns {Array<{url: string, title?: string, snippet?: string}>}
 */
function parseWebCrawlerHtml(html) {
	const sources = [];
	if (typeof html !== "string" || html === "") return sources;
	const blocks = html.split('<div class="web-yahoo__result">');
	for (let index = 1; index < blocks.length; index += 1) {
		const chunk = blocks[index];
		const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/u.exec(chunk);
		if (anchor === null) continue;
		const attributes = anchor[1];
		if (!/\bweb-yahoo__title\b/u.test(attributes)) continue;
		const href = /\bhref="([^"]*)"/u.exec(attributes);
		if (href === null) continue;
		const url = decodeEntities(href[1]);
		if (!isHttpUrl(url)) continue;
		/** @type {{url: string, title?: string, snippet?: string}} */
		const source = { url };
		const title = stripInlineMarkup(anchor[2]);
		if (title !== "") source.title = title;
		const description = /<span class="web-yahoo__description">([\s\S]*?)<\/span>/u.exec(chunk);
		if (description !== null) {
			const snippet = snippetOf(stripInlineMarkup(description[1]));
			if (snippet !== undefined) source.snippet = snippet;
		}
		sources.push(source);
	}
	return sources;
}

/**
 * Strip search operators before handing a query to a front-end that reacts to
 * them by serving a captcha instead of results.
 *
 * WebCrawler redirects `site:github.com foo` to `/captcha`, so the operator has
 * to go. `site:` is turned into the bare domain instead of being dropped, which
 * keeps most of the caller's intent.
 * @param {string} query - the raw query.
 * @returns {string} a query with operators downgraded to plain words.
 */
function stripSearchOperators(query) {
	let text = typeof query === "string" ? query : "";
	// Turn `site:host` into the host, which still biases the engine toward it.
	text = text.replace(/\bsite:(\S+)/giu, "$1");
	// Drop the remaining operators but keep their argument as a plain word.
	text = text.replace(/\b(?:inurl|intitle|intext|filetype|ext|related|cache|allinurl|allintitle):/giu, "");
	// Quoted phrases and bare punctuation are fine as plain words.
	text = text.replace(/["'“”‘’]/gu, " ");
	return text.replace(/\s+/gu, " ").trim();
}

async function searchWebCrawler(query, ctx) {
	const cleaned = stripSearchOperators(query);
	const url = `https://www.webcrawler.com/search/web?q=${encodeURIComponent(cleaned === "" ? query : cleaned)}`;
	// A challenge is issued as a redirect to `/captcha`, so do not follow it: the
	// captcha page would come back as a misleading HTTP 200.
	const { status, ok, text, retryAfterMs } = await requestText(url, {
		headers: browserHeaders(),
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "WebCrawler",
		redirect: "manual",
	});
	if (!ok) {
		// Any remaining redirect from a search endpoint is a refusal, not a result.
		const throttle = isThrottleStatus(status) || (status >= 300 && status < 400);
		const error = new SearchError(
			`WebCrawler search failed with HTTP ${status}${throttle ? " (bot challenge)" : ""}`,
			throttle ? CODE_RATE_LIMITED : CODE_PROVIDER,
		);
		if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
		throw error;
	}
	const sources = parseWebCrawlerHtml(text);
	// A bot wall is also served as HTTP 200 with no result blocks at all, so an
	// empty parse is a failure signal rather than an honest "no results": the
	// engine always returns fuzzy matches, never a bare empty page.
	if (sources.length === 0) {
		throw new SearchError("WebCrawler returned a challenge page instead of results", CODE_RATE_LIMITED);
	}
	return sources.slice(0, ctx.maxResults);
}

// ── Mwmbl (community index, JSON) ────────────────────────────────────────────

/**
 * Join an Mwmbl highlight field. Both `title` and `extract` are arrays of
 * `{ value, is_bold }` segments, but tolerate plain strings.
 * @param {unknown} value - the field from the API.
 * @returns {string} the concatenated text.
 */
function joinMwmblSegments(value) {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts = [];
	for (const item of value) {
		if (typeof item === "string") parts.push(item);
		else if (item !== null && typeof item === "object" && typeof item.value === "string") parts.push(item.value);
	}
	return parts.join("");
}

/**
 * Parse the Mwmbl search payload: an array of
 * `{ url, title: [{value,is_bold}], extract: [{value,is_bold}] }`.
 * @param {unknown} payload - parsed JSON, or the raw body.
 * @returns {Array<{url: string, title?: string, snippet?: string}>}
 */
function parseMwmblJson(payload) {
	let items = payload;
	if (typeof payload === "string") {
		try {
			items = JSON.parse(payload);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(items)) return [];
	const sources = [];
	for (const item of items) {
		if (item === null || typeof item !== "object" || !isHttpUrl(item.url)) continue;
		/** @type {{url: string, title?: string, snippet?: string}} */
		const source = { url: item.url };
		const title = stripInlineMarkup(joinMwmblSegments(item.title));
		if (title !== "") source.title = title;
		const snippet = snippetOf(stripInlineMarkup(joinMwmblSegments(item.extract)));
		if (snippet !== undefined) source.snippet = snippet;
		sources.push(source);
	}
	return sources;
}

async function searchMwmbl(query, ctx) {
	const url = `https://api.mwmbl.org/search/?s=${encodeURIComponent(query)}&count=${ctx.maxResults}`;
	const payload = await requestJson(url, {
		headers: apiHeaders("application/json"),
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "Mwmbl",
	});
	return parseMwmblJson(payload).slice(0, ctx.maxResults);
}

// ── Wikipedia (JSON) ─────────────────────────────────────────────────────────

/**
 * Parse the MediaWiki search API payload.
 * @param {any} payload - parsed JSON.
 * @returns {Array<{url: string, title?: string, snippet?: string}>}
 */
function parseWikipediaJson(payload) {
	const hits = payload?.query?.search;
	if (!Array.isArray(hits)) return [];
	const sources = [];
	for (const hit of hits) {
		if (hit === null || typeof hit !== "object" || typeof hit.title !== "string" || hit.title === "") continue;
		/** @type {{url: string, title?: string, snippet?: string}} */
		const source = { url: wikipediaUrl(hit.title), title: hit.title };
		const snippet = snippetOf(stripInlineMarkup(hit.snippet));
		if (snippet !== undefined) source.snippet = snippet;
		sources.push(source);
	}
	return sources;
}

/**
 * Rank terms by how much signal they carry, longest first. Used for the
 * two-token retry, where the most specific words are the best chance of a hit.
 * @param {string} query - the raw query.
 * @returns {string[]} terms, strongest first.
 */
function strongestTerms(query) {
	const text = typeof query === "string" ? query : "";
	const seen = new Set();
	const terms = [];
	for (const token of text.split(/\s+/u)) {
		const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.+#-]+$/gu, "");
		if (bare === "" || STOPWORDS.has(bare.toLowerCase())) continue;
		const key = bare.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		terms.push({ token, weight: bare.length });
	}
	return terms.sort((a, b) => b.weight - a.weight).map((term) => term.token);
}

async function searchWikipedia(query, ctx) {
	/** One `list=search` round-trip. */
	const search = async (terms) => {
		const url =
			"https://en.wikipedia.org/w/api.php?action=query&list=search&format=json" +
			`&srlimit=${ctx.maxResults}&srsearch=${encodeURIComponent(terms)}`;
		const payload = await requestJson(url, {
			headers: apiHeaders("application/json"),
			signal: ctx.signal,
			timeoutMs: ctx.timeoutMs,
			label: "Wikipedia",
		});
		return parseWikipediaJson(payload);
	};

	const trimmed = trimQuery(query);
	let sources = await search(trimmed);
	// `srsearch` ANDs its terms, so a keyword-rich query can legitimately return
	// nothing. One retry with the two strongest terms recovers those cases.
	if (sources.length === 0) {
		const strongest = strongestTerms(query).slice(0, 2).join(" ");
		if (strongest !== "" && strongest !== trimmed) sources = await search(strongest);
	}
	return sources.slice(0, ctx.maxResults);
}

// ── Hacker News (Algolia JSON) ───────────────────────────────────────────────

/**
 * Parse the Algolia HN search payload, falling back through the parent story
 * link to the item's own HN discussion page when a hit has no outbound URL.
 * @param {any} payload - parsed JSON.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
function parseHackerNewsJson(payload) {
	const hits = payload?.hits;
	if (!Array.isArray(hits)) return [];
	const sources = [];
	for (const hit of hits) {
		if (hit === null || typeof hit !== "object") continue;
		const title = typeof hit.title === "string" ? hit.title : typeof hit.story_title === "string" ? hit.story_title : "";
		if (title === "") continue;
		// `url` is null on most comment hits and text-only stories, so fall back
		// through the parent story link to the item's own discussion page.
		const url = isHttpUrl(hit.url)
			? hit.url
			: isHttpUrl(hit.story_url)
				? hit.story_url
				: typeof hit.objectID === "string" && hit.objectID !== ""
					? `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`
					: undefined;
		if (url === undefined) continue;
		/** @type {{url: string, title?: string, snippet?: string, publishedAt?: string}} */
		const source = { url, title };
		const body = typeof hit.story_text === "string" && hit.story_text !== "" ? hit.story_text : hit.comment_text;
		const snippet = snippetOf(stripInlineMarkup(typeof body === "string" ? body : ""));
		if (snippet !== undefined) source.snippet = snippet;
		if (typeof hit.created_at === "string" && hit.created_at !== "") source.publishedAt = hit.created_at;
		sources.push(source);
	}
	return sources;
}

async function searchHackerNews(query, ctx) {
	const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${ctx.maxResults}`;
	const payload = await requestJson(url, {
		headers: apiHeaders("application/json"),
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "Hacker News",
	});
	return parseHackerNewsJson(payload).slice(0, ctx.maxResults);
}

// ── MDN (JSON) ───────────────────────────────────────────────────────────────

/**
 * Parse the MDN search payload. `mdn_url` is a site-relative path.
 * @param {any} payload - parsed JSON.
 * @returns {Array<{url: string, title?: string, snippet?: string}>}
 */
function parseMdnJson(payload) {
	const documents = payload?.documents;
	if (!Array.isArray(documents)) return [];
	const sources = [];
	for (const document of documents) {
		if (document === null || typeof document !== "object") continue;
		if (typeof document.mdn_url !== "string" || document.mdn_url === "") continue;
		const url = `https://developer.mozilla.org${document.mdn_url}`;
		if (!isHttpUrl(url)) continue;
		/** @type {{url: string, title?: string, snippet?: string}} */
		const source = { url };
		if (typeof document.title === "string" && document.title.trim() !== "") source.title = document.title.trim();
		const snippet = snippetOf(stripHtml(document.summary));
		if (snippet !== undefined) source.snippet = snippet;
		sources.push(source);
	}
	return sources;
}

async function searchMdn(query, ctx) {
	const url = `https://developer.mozilla.org/api/v1/search?locale=en-US&size=${ctx.maxResults}&q=${encodeURIComponent(query)}`;
	const payload = await requestJson(url, {
		headers: apiHeaders("application/json"),
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "MDN",
	});
	return parseMdnJson(payload).slice(0, ctx.maxResults);
}

// ── npm registry (JSON) ──────────────────────────────────────────────────────

/**
 * Parse the npm registry search payload.
 * @param {any} payload - parsed JSON.
 * @returns {Array<{url: string, title?: string, snippet?: string}>}
 */
function parseNpmJson(payload) {
	const objects = payload?.objects;
	if (!Array.isArray(objects)) return [];
	const sources = [];
	for (const object of objects) {
		const pkg = object?.package;
		if (pkg === null || typeof pkg !== "object" || typeof pkg.name !== "string" || pkg.name === "") continue;
		const url = isHttpUrl(pkg.links?.npm) ? pkg.links.npm : `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}`;
		/** @type {{url: string, title?: string, snippet?: string}} */
		const source = { url, title: pkg.name };
		const snippet = snippetOf(typeof pkg.description === "string" ? pkg.description : "");
		if (snippet !== undefined) source.snippet = snippet;
		sources.push(source);
	}
	return sources;
}

async function searchNpm(query, ctx) {
	const url = `https://registry.npmjs.org/-/v1/search?size=${ctx.maxResults}&text=${encodeURIComponent(query)}`;
	const payload = await requestJson(url, {
		headers: apiHeaders("application/json"),
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "npm",
	});
	return parseNpmJson(payload).slice(0, ctx.maxResults);
}

// ── arXiv (Atom XML) ─────────────────────────────────────────────────────────

/** Read one XML element's text, unwrapping a CDATA section if present. */
function xmlElement(xml, tag) {
	const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "u").exec(xml);
	if (match === null) return "";
	const value = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1");
	return stripHtml(value);
}

/**
 * Parse an arXiv Atom feed into sources.
 * @param {string} xml - the feed body.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
function parseArxivXml(xml) {
	const sources = [];
	if (typeof xml !== "string" || xml === "") return sources;
	for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)) {
		const entry = match[1];
		// The feed reports `http://arxiv.org/abs/...`, which 301s to https; cite the
		// canonical https URL so a fetch does not pay for the redirect.
		const url = xmlElement(entry, "id").replace(/^http:\/\/arxiv\.org\//u, "https://arxiv.org/");
		if (!isHttpUrl(url)) continue;
		/** @type {{url: string, title?: string, snippet?: string, publishedAt?: string}} */
		const source = { url };
		const title = xmlElement(entry, "title");
		if (title !== "") source.title = title;
		const snippet = snippetOf(xmlElement(entry, "summary"));
		if (snippet !== undefined) source.snippet = snippet;
		const published = xmlElement(entry, "published");
		if (published !== "") source.publishedAt = published;
		sources.push(source);
	}
	return sources;
}

async function searchArxiv(query, ctx) {
	const url =
		"https://export.arxiv.org/api/query?max_results=" +
		`${ctx.maxResults}&search_query=${encodeURIComponent(`all:${query}`)}`;
	const xml = await requestOk(url, {
		headers: apiHeaders("application/atom+xml, application/xml, text/xml"),
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "arXiv",
	});
	return parseArxivXml(xml).slice(0, ctx.maxResults);
}

// ── Google News (RSS) ────────────────────────────────────────────────────────

/**
 * Parse an RSS 2.0 news feed. Google News items carry a redirect wrapper as
 * their link and the real publisher in `<source url>`; the publisher name is
 * appended to the title so the citation is still attributable.
 * @param {string} xml - the feed body.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
function parseRssItems(xml) {
	const sources = [];
	if (typeof xml !== "string" || xml === "") return sources;
	for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)) {
		const item = match[1];
		// The channel itself carries a <link> before any <item>, so only read the
		// link that belongs to this item's block.
		const url = xmlElement(item, "link");
		if (!isHttpUrl(url)) continue;
		/** @type {{url: string, title?: string, snippet?: string, publishedAt?: string}} */
		const source = { url };
		// The item link is a news.google.com redirect wrapper, not the publisher
		// URL, so name the publisher explicitly instead of hiding it behind it.
		const publisher = /<source\b[^>]*>([\s\S]*?)<\/source>/u.exec(item);
		const publisherName = publisher === null ? "" : stripHtml(publisher[1]);
		const title = xmlElement(item, "title");
		if (title !== "") source.title = publisherName === "" ? title : `${title} — ${publisherName}`;
		else if (publisherName !== "") source.title = publisherName;
		const snippet = snippetOf(xmlElement(item, "description"));
		if (snippet !== undefined) source.snippet = snippet;
		const published = xmlElement(item, "pubDate");
		if (published !== "") source.publishedAt = published;
		sources.push(source);
	}
	return sources;
}

async function searchGoogleNews(query, ctx) {
	const url =
		"https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en" + `&q=${encodeURIComponent(query)}`;
	const xml = await requestOk(url, {
		headers: apiHeaders("application/rss+xml, application/xml, text/xml"),
		signal: ctx.signal,
		timeoutMs: ctx.timeoutMs,
		label: "Google News",
	});
	return parseRssItems(xml).slice(0, ctx.maxResults);
}

// ── Backend registry ─────────────────────────────────────────────────────────

/**
 * Every backend this plugin knows, keyed by its config name.
 * `kind` is documentation only: `general` backends answer free-text web
 * queries, `specialist` ones only shine for a matching topic and are therefore
 * listed after the general ones.
 */
const BACKENDS = {
	lumy: { id: "lumy", label: "Lumy", kind: "general", search: searchLumy },
	webcrawler: { id: "webcrawler", label: "WebCrawler", kind: "general", search: searchWebCrawler },
	mwmbl: { id: "mwmbl", label: "Mwmbl", kind: "general", search: searchMwmbl },
	exa: { id: "exa", label: "Exa", kind: "general", search: searchExa },
	parallel: { id: "parallel", label: "Parallel", kind: "general", search: searchParallel },
	wikipedia: { id: "wikipedia", label: "Wikipedia", kind: "specialist", search: searchWikipedia },
	hackernews: { id: "hackernews", label: "Hacker News", kind: "specialist", search: searchHackerNews },
	tinyfish: { id: "tinyfish", label: "TinyFish", kind: "general", search: searchTinyFish },
	mdn: { id: "mdn", label: "MDN", kind: "specialist", search: searchMdn },
	npm: { id: "npm", label: "npm", kind: "specialist", search: searchNpm },
	arxiv: { id: "arxiv", label: "arXiv", kind: "specialist", search: searchArxiv },
	googlenews: { id: "googlenews", label: "Google News", kind: "specialist", search: searchGoogleNews },
};

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * One keyless search provider over a chain of public backends.
 *
 * `available()` is a pure local check — the public backends need no
 * configuration, so the provider is usable whenever at least one backend is
 * configured. It never makes a network call, as the seam requires.
 */
export class KeylessSearchProvider {
	#backends;
	#timeoutMs;
	#maxResults;
	#logger;
	/** @type {Map<string, { until: number, strikes: number }>} */
	#cooldowns = new Map();

	/**
	 * Backends may be given either as resolved registry entries or as their
	 * config names, so the class is usable directly in tests and tooling.
	 * @param {{
	 *   backends: Array<{id: string, label: string, kind: string, search: Function} | string>,
	 *   timeoutMs: number,
	 *   maxResults: number,
	 *   logger?: { info?: Function, warn?: Function },
	 * }} options
	 */
	constructor(options) {
		this.id = PROVIDER_ID;
		this.#backends = options.backends.map((backend) =>
			typeof backend === "string" ? BACKENDS[String(backend).trim().toLowerCase()] : backend,
		).filter((backend) => backend !== undefined);
		this.#timeoutMs = options.timeoutMs;
		this.#maxResults = options.maxResults;
		this.#logger = options.logger;
	}

	/** Cheap local usability check; never makes a network call. */
	available() {
		return this.#backends.length > 0;
	}

	/** The backend ids this provider will try, in order. */
	get backends() {
		return this.#backends.map((backend) => backend.id);
	}

	/** Log one structured warning line without assuming a logger shape. */
	#warn(event, backend, error) {
		this.#logger?.warn?.(
			JSON.stringify({ level: "warn", msg: "keyless_search_backend_failed", backend, event, error }),
		);
	}

	/**
	 * Put a backend on cooldown after a failure. Consecutive failures double the
	 * window, so a permanently blocked endpoint costs one attempt every 15
	 * minutes instead of one attempt per search.
	 */
	#penalize(backendId, requestedMs) {
		const previous = this.#cooldowns.get(backendId);
		const strikes = (previous?.strikes ?? 0) + 1;
		// A server-supplied wait wins over the exponential guess: it is exact, and
		// guessing too short just burns another request against a blocked endpoint.
		const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** (strikes - 1), MAX_COOLDOWN_MS);
		const cooldownMs =
			requestedMs === undefined
				? backoff
				: Math.min(Math.max(requestedMs, backoff), MAX_ADVERTISED_COOLDOWN_MS);
		this.#cooldowns.set(backendId, { strikes, until: Date.now() + cooldownMs });
		return cooldownMs;
	}

	/**
	 * Run one search through the backend chain; the first backend that returns
	 * sources wins, and a failing or empty one is skipped.
	 * @param {{ query: string, maxResults?: number }} request - the seam's request.
	 * @param {AbortSignal} [signal] - caller cancellation, forwarded to every backend.
	 * @returns {Promise<{sources: ReadonlyArray<object>, truncated: boolean}>}
	 */
	async search(request, signal) {
		const query = request?.query;
		if (typeof query !== "string" || query.trim() === "") {
			throw new SearchError("search query must be a non-empty string", CODE_PROVIDER);
		}
		const maxResults =
			request.maxResults === undefined
				? this.#maxResults
				: Math.max(1, Math.min(clampResults(request.maxResults, this.#maxResults), this.#maxResults));

		const failures = [];
		for (const backend of this.#backends) {
			if (signal?.aborted === true) throw new SearchError("search aborted", CODE_ABORTED, { cause: signal.reason });

			const cooldown = this.#cooldowns.get(backend.id);
			if (cooldown !== undefined && cooldown.until > Date.now()) {
				failures.push(`${backend.id}: cooling down for ${Math.ceil((cooldown.until - Date.now()) / 1000)}s`);
				continue;
			}

			try {
				const sources = await backend.search(query, {
					maxResults,
					signal,
					timeoutMs: this.#timeoutMs,
				});
				const usable = Array.isArray(sources) ? sources.filter((source) => isHttpUrl(source?.url)) : [];
				if (usable.length > 0) {
					if (cooldown !== undefined) this.#cooldowns.delete(backend.id);
					return { sources: usable.slice(0, maxResults), truncated: usable.length > maxResults };
				}
				failures.push(`${backend.id}: no results`);
			} catch (error) {
				if (error instanceof SearchError && error.code === CODE_ABORTED) throw error;
				const reason = error instanceof Error ? error.message : String(error);
				const cooldownMs = this.#penalize(backend.id, error?.retryAfterMs);
				failures.push(`${backend.id}: ${reason}`);
				this.#warn("backend_failed", backend.id, `${reason} (cooldown ${Math.round(cooldownMs / 1000)}s)`);
			}
		}

		throw new SearchError(
			`keyless web search failed; no backend returned results (${failures.join("; ") || "no backends configured"})`,
			CODE_PROVIDER,
		);
	}
}

/** Resolve configured backend names, dropping unknown ones with a warning. */
function resolveBackends(names) {
	const out = [];
	for (const raw of names) {
		const key = String(raw).trim().toLowerCase();
		const backend = BACKENDS[key];
		if (backend === undefined) {
			console.warn(JSON.stringify({ level: "warn", msg: "keyless_search_unknown_backend", backend: raw }));
			continue;
		}
		if (!out.includes(backend)) out.push(backend);
	}
	// Fall back to the default chain only when the configured names yielded nothing.
	return out.length > 0 ? out : resolveBackendsDefault();
}

/** The default backend chain, resolved to registry entries. */
function resolveBackendsDefault() {
	return DEFAULT_BACKENDS.map((id) => BACKENDS[id]);
}

/** Cordis plugin name used by loader diagnostics. */
const name = "keyless-search";

/** The web seam this provider registers into. */
const inject = ["web"];

/* Configuration (no cordis `Config`; defaults are applied in {@link apply}):
 *   backends    string[]  backends tried in order; the first that answers wins
 *                         (default: see DEFAULT_BACKENDS). Add mdn, npm, arxiv, or
 *                         googlenews to include topic-specific sources.
 *   timeoutMs   number    per-search timeout for one backend, ms (default: 20000)
 *   maxResults  number    upper bound on sources requested per backend (default: 10)
 */

/**
 * Register the keyless search provider with `ctx.web`.
 * @param {{ web: { registerSearchProvider(p: unknown): unknown }, logger?: object }} ctx - plugin context carrying the `web` service.
 * @param {Record<string, unknown>} [config] - the raw config section; defaults applied here.
 */
function apply(ctx, config) {
	const raw = config ?? {};
	const names = Array.isArray(raw.backends) && raw.backends.length > 0 ? raw.backends : DEFAULT_BACKENDS;
	const timeoutMs = Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS;
	const maxResults = Number.isInteger(raw.maxResults) && raw.maxResults > 0 ? raw.maxResults : DEFAULT_MAX_RESULTS;
	const provider = new KeylessSearchProvider({
		backends: resolveBackends(names),
		timeoutMs,
		maxResults,
		logger: ctx.logger,
	});
	ctx.web.registerSearchProvider(provider);
	ctx.logger?.info?.("keyless web search registered (id: %s, backends: %s)", provider.id, provider.backends.join(", "));
}

export {
	BACKENDS,
	CODE_ABORTED,
	CODE_PROVIDER,
	CODE_RATE_LIMITED,
	CODE_TIMEOUT,
	DEFAULT_BACKENDS,
	PROVIDER_ID,
	apply,
	inject,
	name,
	parseArxivXml,
	parseExaText,
	parseHackerNewsJson,
	parseMdnJson,
	parseMwmblJson,
	parseNpmJson,
	parseParallelText,
	parseRssItems,
	parseSearxngJson,
	parseTinyFishJson,
	parseWebCrawlerHtml,
	parseWikipediaJson,
};
