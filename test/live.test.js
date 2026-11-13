/**
 * Live-network smoke test: proves the keyless chain actually returns sources
 * from real backends without any credential.
 *
 * This test needs outbound network access and is therefore **opt-in** so the
 * default `node --test` run stays hermetic:
 *
 *   DSH_KEYLESS_LIVE=1 node --test test/live.test.js
 *
 * It intentionally asserts "at least one backend answered" rather than pinning a
 * specific backend, because which public endpoint is reachable varies by network
 * and by the day.
 *
 * @module dsh-keyless-search/test/live
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BACKENDS, KeylessSearchProvider } from "../lib/index.js";

const LIVE = process.env.DSH_KEYLESS_LIVE === "1";
const skip = LIVE ? false : "set DSH_KEYLESS_LIVE=1 to run network tests";

test("the default chain returns real sources for a real query", { skip, timeout: 120_000 }, async () => {
	const provider = new KeylessSearchProvider({
		backends: [...DEFAULT_BACKENDS],
		timeoutMs: 20_000,
		maxResults: 8,
	});
	const result = await provider.search({ query: "node.js fetch timeout abort signal", maxResults: 5 });

	assert.ok(result.sources.length > 0, "expected at least one source");
	assert.ok(result.sources.length <= 5, "the seam bound is honoured");
	for (const source of result.sources) {
		assert.match(source.url, /^https?:\/\//u, `${source.url} is an absolute http(s) url`);
	}
});

test("the chain still answers a non-English query", { skip, timeout: 120_000 }, async () => {
	const provider = new KeylessSearchProvider({
		backends: [...DEFAULT_BACKENDS],
		timeoutMs: 20_000,
		maxResults: 5,
	});
	const result = await provider.search({ query: "cara membuat nasi goreng", maxResults: 5 });
	assert.ok(result.sources.length > 0, "expected at least one source");
});
