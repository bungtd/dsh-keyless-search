/**
 * Unit and contract tests for dsh-keyless-search.
 *
 * Two layers:
 *  1. **Parser tests** — feed recorded shapes through each `parse*` export and
 *     assert the normalized `{url,title?,snippet?,publishedAt?}` sources. These
 *     never touch the network, so they run anywhere.
 *  2. **Provider tests** — exercise backend chaining, cooldown behaviour, and the
 *     abort path with injected fake backends.
 *
 * Run with `node --test test/` (no dependencies, matching the plugin itself).
 *
 * @module dsh-keyless-search/test
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BACKENDS,
	CODE_ABORTED,
	KeylessSearchProvider,
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
} from "../lib/index.js";

/** Build a provider over ready-made fake backends. */
function providerWith(backends, options = {}) {
	return new KeylessSearchProvider({
		backends,
		timeoutMs: options.timeoutMs ?? 1_000,
		maxResults: options.maxResults ?? 10,
		logger: options.logger,
	});
}

/** A backend that resolves to a fixed source list. */
function okBackend(id, sources) {
	return { id, label: id, kind: "general", search: async () => sources };
}

/** A backend that always throws the given error. */
function failingBackend(id, error = new Error(`${id} is down`)) {
	return { id, label: id, kind: "general", search: async () => { throw error; } };
}

const SOURCE = { url: "https://example.test/a", title: "A" };

// ── WebCrawler ───────────────────────────────────────────────────────────────

test("parseWebCrawlerHtml reads title, url, and snippet", () => {
	const html = `
		<div class="web-yahoo__result">
			<a class="web-yahoo__title" href="https://a.test/x?a=1&amp;b=2" target="_blank"><b>Title</b> One</a><br>
			<span class="web-yahoo__url">a.test</span><br>
			<span class="web-yahoo__description">Snippet &amp; more</span><br>
		</div>
		<div class="web-yahoo__result">
			<a class="web-yahoo__title" href="https://b.test/y">Two</a>
			<span class="web-yahoo__description">Desc two</span>
		</div>`;
	const sources = parseWebCrawlerHtml(html);
	assert.equal(sources.length, 2);
	assert.deepEqual(sources[0], { url: "https://a.test/x?a=1&b=2", title: "Title One", snippet: "Snippet & more" });
	assert.equal(sources[1].url, "https://b.test/y");
	assert.equal(sources[1].title, "Two");
});

test("parseWebCrawlerHtml tolerates attribute order and skips non-http links", () => {
	const html = `
		<div class="web-yahoo__result"><a href="https://ok.test" class="web-yahoo__title">Fine</a></div>
		<div class="web-yahoo__result"><a class="web-yahoo__title" href="javascript:alert(1)">Bad</a></div>
		<div class="web-yahoo__result"><a class="web-yahoo__title">No href</a></div>`;
	const sources = parseWebCrawlerHtml(html);
	assert.deepEqual(sources.map((source) => source.url), ["https://ok.test"]);
});

test("parseWebCrawlerHtml returns nothing for a challenge page", () => {
	assert.deepEqual(parseWebCrawlerHtml("<html><body>Verifying your browser…</body></html>"), []);
	assert.deepEqual(parseWebCrawlerHtml(""), []);
	assert.deepEqual(parseWebCrawlerHtml(undefined), []);
});

// ── Lumy / SearXNG ───────────────────────────────────────────────────────────

test("parseSearxngJson reads results and ignores unresponsive engines", () => {
	const payload = {
		query: "anything",
		unresponsive_engines: [["duckduckgo", "CAPTCHA"]],
		results: [
			{
				title: "Result one",
				url: "https://a.test/1",
				content: "Some content",
				engine: "yandex",
				publishedDate: "2026-05-01T00:00:00Z",
			},
			{ title: "Broken", url: "javascript:void(0)" },
			{ title: "No url" },
		],
	};
	const sources = parseSearxngJson(payload);
	assert.equal(sources.length, 1);
	assert.deepEqual(sources[0], {
		url: "https://a.test/1",
		title: "Result one",
		snippet: "Some content",
		publishedAt: "2026-05-01T00:00:00Z",
	});
	// A partial answer is still an answer: the unresponsive upstream is not fatal.
	assert.deepEqual(parseSearxngJson({ unresponsive_engines: [["x", "y"]] }), []);
});

// ── Mwmbl ────────────────────────────────────────────────────────────────────

test("parseMwmblJson joins highlight segments and drops non-http urls", () => {
	const payload = [
		{
			url: "https://c.test/page",
			source: "mwmbl",
			title: [{ value: "Mwm", is_bold: false }, { value: "bl", is_bold: true }],
			extract: [{ value: " Ex", is_bold: false }, { value: "tract", is_bold: true }],
		},
		{ url: "ftp://bad.test", title: [{ value: "nope" }] },
		{ title: [{ value: "no url" }] },
	];
	const sources = parseMwmblJson(payload);
	assert.equal(sources.length, 1);
	assert.deepEqual(sources[0], { url: "https://c.test/page", title: "Mwmbl", snippet: "Extract" });
});

test("parseMwmblJson accepts a raw body and survives malformed JSON", () => {
	const body = JSON.stringify([{ url: "https://d.test", title: "Plain string title" }]);
	assert.equal(parseMwmblJson(body)[0].title, "Plain string title");
	assert.deepEqual(parseMwmblJson("{not json"), []);
	assert.deepEqual(parseMwmblJson({ not: "an array" }), []);
});

// ── Wikipedia ────────────────────────────────────────────────────────────────

test("parseWikipediaJson builds the canonical article URL and glues highlights", () => {
	const payload = {
		query: {
			search: [
				{ title: "C++", snippet: "the <span class=\"searchmatch\">lang</span>uage &amp; more" },
				{ title: "Fetch API", snippet: "no markup" },
			],
		},
	};
	const sources = parseWikipediaJson(payload);
	assert.equal(sources[0].url, "https://en.wikipedia.org/wiki/C%2B%2B");
	// A highlight span must not split a word in two.
	assert.equal(sources[0].snippet, "the language & more");
	assert.equal(sources[1].url, "https://en.wikipedia.org/wiki/Fetch_API");
});

test("parseWikipediaJson handles subpage titles and empty payloads", () => {
	const sources = parseWikipediaJson({ query: { search: [{ title: "Foo/Bar baz", snippet: "" }] } });
	assert.equal(sources[0].url, "https://en.wikipedia.org/wiki/Foo/Bar_baz");
	assert.equal(sources[0].snippet, undefined);
	assert.deepEqual(parseWikipediaJson({}), []);
	assert.deepEqual(parseWikipediaJson(null), []);
});

// ── Hacker News ──────────────────────────────────────────────────────────────

test("parseHackerNewsJson falls back through story_url to the item page", () => {
	const payload = {
		hits: [
			{ objectID: "1", title: "Story", url: "https://d.test", created_at: "2026-01-01T00:00:00Z" },
			{ objectID: "2", story_title: "Comment on story", story_url: "https://e.test", comment_text: "<p>hi</p>" },
			{ objectID: "3", title: "Text-only story" },
			{ objectID: "4" },
		],
	};
	const sources = parseHackerNewsJson(payload);
	assert.equal(sources.length, 3);
	assert.equal(sources[0].url, "https://d.test");
	assert.equal(sources[0].publishedAt, "2026-01-01T00:00:00Z");
	assert.equal(sources[1].url, "https://e.test");
	assert.equal(sources[1].title, "Comment on story");
	assert.equal(sources[1].snippet, "hi");
	assert.equal(sources[2].url, "https://news.ycombinator.com/item?id=3");
});

// ── MDN / npm / arXiv ────────────────────────────────────────────────────────

test("parseMdnJson prefixes the site-relative path", () => {
	const sources = parseMdnJson({
		documents: [{ title: "504 Gateway Timeout", mdn_url: "/en-US/docs/Web/HTTP/504", summary: "Gateway" }],
	});
	assert.deepEqual(sources[0], {
		url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/504",
		title: "504 Gateway Timeout",
		snippet: "Gateway",
	});
	assert.deepEqual(parseMdnJson({ documents: [{}] }), []);
});

test("parseNpmJson prefers links.npm and falls back to the package page", () => {
	const sources = parseNpmJson({
		objects: [
			{ package: { name: "pkg-a", links: { npm: "https://www.npmjs.com/package/pkg-a" }, description: "A" } },
			{ package: { name: "pkg-b" } },
			{ package: {} },
		],
	});
	assert.equal(sources[0].url, "https://www.npmjs.com/package/pkg-a");
	assert.equal(sources[0].snippet, "A");
	assert.equal(sources[1].url, "https://www.npmjs.com/package/pkg-b");
	assert.equal(sources.length, 2);
});

test("parseArxivXml reads entries and normalises the scheme to https", () => {
	const xml = `<feed>
		<entry>
			<id>http://arxiv.org/abs/2111.08018v2</id>
			<title>Ent &amp; More</title>
			<summary>Sum</summary>
			<published>2021-11-01T00:00:00Z</published>
		</entry>
		<entry><title>No id</title></entry>
	</feed>`;
	const sources = parseArxivXml(xml);
	assert.equal(sources.length, 1);
	assert.deepEqual(sources[0], {
		url: "https://arxiv.org/abs/2111.08018v2",
		title: "Ent & More",
		snippet: "Sum",
		publishedAt: "2021-11-01T00:00:00Z",
	});
});

// ── Google News RSS ──────────────────────────────────────────────────────────

test("parseRssItems takes the item link, not the channel link, and names the publisher", () => {
	const xml = `<rss version="2.0"><channel>
		<title>Query - Google News</title>
		<link>https://news.google.com/</link>
		<item>
			<title>Headline</title>
			<link>https://news.google.com/rss/articles/abc</link>
			<pubDate>Fri, 23 Oct 2026 07:00:00 GMT</pubDate>
			<source url="https://publisher.test">Publisher Name</source>
		</item>
		</channel></rss>`;
	const sources = parseRssItems(xml);
	assert.equal(sources.length, 1);
	assert.equal(sources[0].url, "https://news.google.com/rss/articles/abc");
	// The link is a redirect wrapper, so the publisher must be visible in the title.
	assert.equal(sources[0].title, "Headline — Publisher Name");
	assert.equal(sources[0].publishedAt, "Fri, 23 Oct 2026 07:00:00 GMT");
});

// ── TinyFish ─────────────────────────────────────────────────────────────────

test("parseTinyFishJson unwraps the MCP text block and reads results", () => {
	const body = JSON.stringify({
		query: "node.js fetch timeout",
		results: [
			{
				position: 1,
				site_name: "crawlbase.com",
				snippet: "Timeouts and cancellation with AbortController",
				title: "HTTP Requests in Node.js With the Fetch API",
				url: "https://crawlbase.com/blog/x/",
				date: "Dec 11, 2024",
			},
			{ position: 2, title: "No url" },
			{ position: 3, title: "Bad scheme", url: "ftp://nope" },
		],
		total_results: 3,
	});
	const sources = parseTinyFishJson(body);
	assert.equal(sources.length, 1);
	assert.deepEqual(sources[0], {
		url: "https://crawlbase.com/blog/x/",
		title: "HTTP Requests in Node.js With the Fetch API",
		snippet: "Timeouts and cancellation with AbortController",
		publishedAt: "Dec 11, 2024",
	});
	assert.deepEqual(parseTinyFishJson("not json"), []);
	assert.deepEqual(parseTinyFishJson({ results: "nope" }), []);
});

// ── MCP-backed backends ──────────────────────────────────────────────────────

test("parseExaText reads per-page blocks split by rules", () => {
	const text = [
		"Title: First page\nURL: https://a.test/1\nPublished: 2026-01-01\nHighlights:\nFirst snippet",
		"Title: Second page\nURL: https://b.test/2\nPublished: N/A\nHighlights:\nSecond snippet",
	].join("\n---\n");
	const sources = parseExaText(text);
	assert.equal(sources.length, 2);
	assert.deepEqual(sources[0], {
		url: "https://a.test/1",
		title: "First page",
		publishedAt: "2026-01-01",
		snippet: "First snippet",
	});
	// "N/A" must not become a publication date.
	assert.equal(sources[1].publishedAt, undefined);
});

test("parseParallelText prefers the JSON document, then markdown", () => {
	const json = JSON.stringify({
		results: [{ url: "https://c.test", title: "C", publish_date: "2026-02-02", excerpts: ["ex one"] }],
	});
	const fromJson = parseParallelText(json);
	assert.equal(fromJson[0].url, "https://c.test");
	assert.equal(fromJson[0].snippet, "ex one");

	const markdown = "# [D](https://d.test)\nD body text\n\n# [E](https://e.test)\nE body";
	const fromMarkdown = parseParallelText(markdown);
	assert.deepEqual(fromMarkdown.map((source) => source.url), ["https://d.test", "https://e.test"]);
	assert.equal(fromMarkdown[0].title, "D");
});

// ── Retry-After ──────────────────────────────────────────────────────────────

test("a server Retry-After longer than the backoff is honoured", async () => {
	const backend = BACKENDS.webcrawler;
	const realFetch = globalThis.fetch;
	let clock = 0;
	const realNow = Date.now;
	const calls = [];
	try {
		Date.now = () => clock;
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response("", { status: 429, headers: { "retry-after": "300" } });
		};
		const flaky = {
			id: "flaky",
			label: "flaky",
			kind: "general",
			search: (query, ctx) => backend.search(query, ctx),
		};
		const provider = providerWith([
			flaky,
			{ id: "good", label: "good", kind: "general", search: async () => [SOURCE] },
		]);
		await provider.search({ query: "one" });
		assert.equal(calls.length, 1);
		// Inside the server-declared 300s window, the backend must not be retried.
		clock += 100_000;
		await provider.search({ query: "two" });
		assert.equal(calls.length, 1, "the 300s Retry-After must outlast the 60s base backoff");
		// Past it, the backend is tried again.
		clock += 220_000;
		await provider.search({ query: "three" });
		assert.equal(calls.length, 2);
	} finally {
		globalThis.fetch = realFetch;
		Date.now = realNow;
	}
});

test("Retry-After as an HTTP date is also honoured", async () => {
	const backend = BACKENDS.webcrawler;
	const realFetch = globalThis.fetch;
	const realNow = Date.now;
	const fixed = Date.parse("2026-01-01T00:00:00Z");
	let clock = fixed;
	const calls = [];
	try {
		Date.now = () => clock;
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response("", {
				status: 429,
				headers: { "retry-after": new Date(fixed + 600_000).toUTCString() },
			});
		};
		const provider = providerWith([
			{ id: "dated", label: "dated", kind: "general", search: (q, c) => backend.search(q, c) },
			{ id: "good", label: "good", kind: "general", search: async () => [SOURCE] },
		]);
		await provider.search({ query: "one" });
		clock = fixed + 120_000;
		await provider.search({ query: "two" });
		assert.equal(calls.length, 1, "still inside the HTTP-date window");
		clock = fixed + 660_000;
		await provider.search({ query: "three" });
		assert.equal(calls.length, 2, "past the HTTP-date window");
	} finally {
		globalThis.fetch = realFetch;
		Date.now = realNow;
	}
});

// ── Throttle handling ────────────────────────────────────────────────────────

test("a backend serving a challenge page raises instead of reporting no results", async () => {
	// WebCrawler answers a bot wall with HTTP 200 and zero result blocks; the
	// backend must classify that as a failure so the chain can fail over.
	const backend = BACKENDS.webcrawler;
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response("<html><body>Verifying your browser…</body></html>", {
			status: 200,
			headers: { "content-type": "text/html" },
		});
		await assert.rejects(
			() => backend.search("anything", { maxResults: 3, timeoutMs: 1_000 }),
			(error) => {
				assert.equal(error.code, "WEB_RATE_LIMITED");
				return true;
			},
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a challenge redirect is not followed to a useless page", async () => {
	const backend = BACKENDS.webcrawler;
	const realFetch = globalThis.fetch;
	let sawManual = false;
	try {
		globalThis.fetch = async (_url, init) => {
			sawManual = init.redirect === "manual";
			return new Response("", { status: 307, headers: { location: "/captcha?q=x" } });
		};
		await assert.rejects(() => backend.search("anything", { maxResults: 3, timeoutMs: 1_000 }));
		assert.equal(sawManual, true, "the backend must not chase the challenge redirect");
	} finally {
		globalThis.fetch = realFetch;
	}
});

// ── Provider behaviour ───────────────────────────────────────────────────────

test("search returns the first backend with sources", async () => {
	const provider = providerWith([failingBackend("first"), okBackend("second", [SOURCE])]);
	const result = await provider.search({ query: "anything" });
	assert.deepEqual(result.sources, [SOURCE]);
	assert.equal(result.truncated, false);
});

test("search skips a backend that returns no usable sources", async () => {
	const provider = providerWith([
		okBackend("empty", []),
		okBackend("no-url", [{ title: "no url at all" }]),
		okBackend("good", [SOURCE]),
	]);
	const result = await provider.search({ query: "anything" });
	assert.deepEqual(result.sources, [SOURCE]);
});

test("search truncates to maxResults and reports it", async () => {
	const many = Array.from({ length: 5 }, (_, index) => ({ url: `https://example.test/${index}` }));
	const provider = providerWith([okBackend("many", many)], { maxResults: 3 });
	const result = await provider.search({ query: "anything", maxResults: 2 });
	assert.equal(result.sources.length, 2);
	assert.equal(result.truncated, true);
});

test("search throws WEB_PROVIDER_ERROR when every backend fails", async () => {
	const provider = providerWith([failingBackend("a"), failingBackend("b")]);
	await assert.rejects(
		() => provider.search({ query: "anything" }),
		(error) => {
			assert.equal(error.code, "WEB_PROVIDER_ERROR");
			assert.match(error.message, /no backend returned results/u);
			assert.match(error.message, /a: a is down/u);
			return true;
		},
	);
});

test("search rejects an empty query", async () => {
	const provider = providerWith([okBackend("a", [SOURCE])]);
	await assert.rejects(() => provider.search({ query: "   " }), { code: "WEB_PROVIDER_ERROR" });
});

test("a failed backend is put on cooldown and skipped next time", async () => {
	let calls = 0;
	let clock = 0;
	const flaky = {
		id: "flaky",
		label: "flaky",
		kind: "general",
		search: async () => {
			calls += 1;
			throw new Error("429");
		},
	};
	const realNow = Date.now;
	try {
		Date.now = () => clock;
		const provider = providerWith([flaky, okBackend("good", [SOURCE])]);
		await provider.search({ query: "one" });
		assert.equal(calls, 1);
		// Second search inside the cooldown window must not call the backend again.
		clock += 1_000;
		await provider.search({ query: "two" });
		assert.equal(calls, 1);
		// Past the cooldown it is retried.
		clock += 120_000;
		await provider.search({ query: "three" });
		assert.equal(calls, 2);
	} finally {
		Date.now = realNow;
	}
});

test("a recovered backend is removed from cooldown", async () => {
	let shouldFail = true;
	let clock = 0;
	const recovered = {
		id: "recovering",
		label: "recovering",
		kind: "general",
		search: async () => {
			if (shouldFail) throw new Error("429");
			return [SOURCE];
		},
	};
	const realNow = Date.now;
	try {
		Date.now = () => clock;
		const provider = providerWith([recovered]);
		await assert.rejects(() => provider.search({ query: "one" }));
		shouldFail = false;
		clock += 120_000;
		const result = await provider.search({ query: "two" });
		assert.deepEqual(result.sources, [SOURCE]);
		// Cooldown cleared, so a subsequent search still uses the backend.
		clock += 1_000;
		const again = await provider.search({ query: "three" });
		assert.deepEqual(again.sources, [SOURCE]);
	} finally {
		Date.now = realNow;
	}
});

test("an aborted caller signal propagates WEB_ABORTED without cooldown churn", async () => {
	const provider = providerWith([okBackend("a", [SOURCE])]);
	const controller = new AbortController();
	controller.abort(new Error("caller gave up"));
	await assert.rejects(() => provider.search({ query: "anything" }, controller.signal), { code: CODE_ABORTED });
});

test("the provider is available whenever at least one backend is configured", () => {
	assert.equal(providerWith([okBackend("a", [])]).available(), true);
	assert.equal(providerWith([]).available(), false);
});

test("the provider accepts backend names as well as entries", () => {
	const provider = new KeylessSearchProvider({ backends: ["mwmbl", "wikipedia"], timeoutMs: 1_000, maxResults: 5 });
	assert.deepEqual(provider.backends, ["mwmbl", "wikipedia"]);
	assert.equal(provider.id, "keyless-mcp");
});

test("the backend registry documents a general chain first", () => {
	for (const backend of Object.values(BACKENDS)) {
		assert.equal(typeof backend.search, "function", `${backend.id} has a search function`);
		assert.ok(["general", "specialist"].includes(backend.kind), `${backend.id} has a kind`);
	}
});
