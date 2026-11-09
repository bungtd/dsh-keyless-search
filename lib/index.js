/**
 * Keyless web search for the DeepSeek Harness web seam (`ctx.web`).
 *
 * Registers one search provider that needs **no API key at all**. Both backends
 * are hosted MCP services that answer unauthenticated — the same approach the
 * OpenCode CLI takes for its `websearch` tool.
 *
 *   Exa      → https://mcp.exa.ai/mcp      tool `web_search_exa`
 *   Parallel → https://mcp.parallel.ai/mcp tool `web_search`
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
 *
 * @module dsh-keyless-search
 */

/** Stable provider id the seam stores this provider under. */
const PROVIDER_ID = "keyless-mcp";

/** Machine-routable failure codes, matching the seam's WebError vocabulary. */
const CODE_ABORTED = "WEB_ABORTED";
const CODE_PROVIDER = "WEB_PROVIDER_ERROR";
const CODE_TIMEOUT = "WEB_SEARCH_TIMEOUT";

/** Banner every request sends so the hosted servers can attribute traffic. */
const USER_AGENT = "dsh-keyless-search/1.0.0";

/** Defaults, mirrored in the README and the bundle patch. */
const DEFAULT_BACKENDS = ["exa", "parallel"];
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESULTS = 10;

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
	const { signal: composite, cleanup } = withTimeout(signal, timeoutMs);
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			redirect: "error",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"user-agent": USER_AGENT,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
			signal: composite,
		});
	} catch (error) {
		if (signal?.aborted === true) throw new SearchError(`${label} search aborted`, CODE_ABORTED, { cause: error });
		if (isTimeoutError(error, signal)) {
			throw new SearchError(`${label} search timed out after ${timeoutMs}ms`, CODE_TIMEOUT, { cause: error });
		}
		throw new SearchError(`${label} search request failed: ${String(error)}`, CODE_PROVIDER, { cause: error });
	} finally {
		cleanup();
	}

	const body = await response.text().catch(() => "");
	if (!response.ok) {
		throw new SearchError(`${label} search failed with HTTP ${response.status}: ${body.slice(0, 300)}`, CODE_PROVIDER);
	}

	let payload;
	try {
		payload = readMcpPayload(body);
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

/** Trim and cap a snippet so one long page cannot flood the model's context. */
function snippetOf(text) {
	const clean = text.replace(/\s+/gu, " ").trim();
	if (clean === "") return undefined;
	return clean.length > 800 ? `${clean.slice(0, 800)}…` : clean;
}

/** Clamp a requested result count into the supported range. */
function clampResults(value, fallback) {
	const n = Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.max(1, Math.min(n, 100));
}

// ── Exa ──────────────────────────────────────────────────────────────────────

/**
 * Parse Exa's per-page blocks:
 *   Title: … / URL: … / Published: … / Author: … / Highlights: …
 * separated by `---` rules.
 * @param {string} text - the backend's text payload.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
export function parseExaText(text) {
	const sources = [];
	if (typeof text !== "string" || text.trim() === "") return sources;
	for (const chunk of text.split(/\n-{3,}\s*(?:\n|$)/u)) {
		const urlMatch = /^URL:\s*(\S+)\s*$/mu.exec(chunk);
		if (urlMatch === null) continue;
		const url = urlMatch[1];
		if (!/^https?:\/\//u.test(url)) continue;
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

async function searchExa(query, options) {
	const maxResults = clampResults(options.maxResults, 8);
	const text = await callMcp({
		url: options.url ?? "https://mcp.exa.ai/mcp",
		tool: "web_search_exa",
		args: { query, numResults: maxResults },
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? 30_000,
		label: "Exa",
	});
	return { sources: parseExaText(text).slice(0, maxResults), truncated: false };
}

// ── Parallel ─────────────────────────────────────────────────────────────────

/**
 * Parse Parallel's answer: a JSON document first, markdown links after.
 * @param {string} text - the backend's text payload.
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
export function parseParallelText(text) {
	const sources = [];
	if (typeof text !== "string" || text.trim() === "") return sources;

	// Preferred shape: { search_id, results: [{ url, title, publish_date, excerpts }] }
	if (text.trimStart().startsWith("{")) {
		try {
			const doc = JSON.parse(text);
			const results = Array.isArray(doc?.results) ? doc.results : [];
			for (const item of results) {
				if (item === null || typeof item !== "object") continue;
				if (typeof item.url !== "string" || !/^https?:\/\//u.test(item.url)) continue;
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
		const snippet = snippetOf(body);
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

async function searchParallel(query, options) {
	const maxResults = clampResults(options.maxResults, 8);
	const text = await callMcp({
		url: options.url ?? "https://mcp.parallel.ai/mcp",
		tool: "web_search",
		args: { objective: query, search_queries: [query] },
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? 45_000,
		label: "Parallel",
	});
	return { sources: parseParallelText(text).slice(0, maxResults), truncated: false };
}

/** Every backend this plugin knows, keyed by its config name. */
const BACKENDS = {
	exa: { id: "exa", label: "Exa", search: searchExa },
	parallel: { id: "parallel", label: "Parallel", search: searchParallel },
};

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * One keyless search provider over a chain of hosted-MCP backends.
 *
 * `available()` is a pure local check — hosted backends need no configuration,
 * so the provider is usable whenever at least one backend is configured. It
 * never makes a network call, as the seam requires.
 */
export class KeylessSearchProvider {
	#backends;
	#timeoutMs;
	#maxResults;

	/**
	 * @param {{ backends: Array<{id: string, label: string, search: Function}>, timeoutMs: number, maxResults: number }} options
	 */
	constructor(options) {
		this.id = PROVIDER_ID;
		this.#backends = options.backends;
		this.#timeoutMs = options.timeoutMs;
		this.#maxResults = options.maxResults;
	}

	/** Cheap local usability check; never makes a network call. */
	available() {
		return this.#backends.length > 0;
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
			request.maxResults === undefined ? this.#maxResults : Math.max(1, Math.min(clampResults(request.maxResults, this.#maxResults), this.#maxResults));

		const failures = [];
		for (const backend of this.#backends) {
			if (signal?.aborted === true) throw new SearchError("search aborted", CODE_ABORTED, { cause: signal.reason });
			try {
				const outcome = await backend.search(query, { maxResults, signal, timeoutMs: this.#timeoutMs });
				if (outcome.sources.length > 0) return outcome;
				failures.push(`${backend.id}: no results`);
			} catch (error) {
				if (error instanceof SearchError && error.code === CODE_ABORTED) throw error;
				const reason = error instanceof Error ? error.message : String(error);
				failures.push(`${backend.id}: ${reason}`);
				console.warn(JSON.stringify({ level: "warn", msg: "keyless_search_backend_failed", backend: backend.id, error: reason }));
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
	return out.length > 0 ? out : [BACKENDS.exa, BACKENDS.parallel];
}

/** Cordis plugin name used by loader diagnostics. */
const name = "keyless-search";

/** The web seam this provider registers into. */
const inject = ["web"];

/* Configuration (no cordis `Config`; defaults are applied in {@link apply}):
 *   backends    string[]  backends tried in order; the first that answers wins
 *                         (default: exa, parallel)
 *   timeoutMs   number    per-search timeout for one backend, ms (default: 45000)
 *   maxResults  number    upper bound on sources requested per backend (default: 10)
 */

/**
 * Register the keyless search provider with `ctx.web`.
 * @param {{ web: { registerSearchProvider(p: unknown): unknown } }} ctx - plugin context carrying the `web` service.
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
	});
	ctx.web.registerSearchProvider(provider);
	ctx.logger?.info?.("keyless web search registered (id: %s)", provider.id);
}

export { PROVIDER_ID, apply, inject, name };
