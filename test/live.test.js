/**
 * Live-network smoke test: proves the keyless chain actually returns sources
 * from real backends without any credential.
 *
 * This test needs outbound network access and is therefore **opt-in** so the
 * default `node --test` run stays hermetic. Run it directly:
 *
 *   npm run test:live          # or: node test/live.test.js
 *
 * Running the file as a plain script enables it; running it through the test
 * runner (which `npm test` does) skips it. That keeps `npm test` offline without
 * an env-var dance, which matters because `VAR=1 cmd` is POSIX-only and this
 * package supports Windows.
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

/**
 * Enabled when this file is run as a plain script (`npm run test:live`) or when
 * `DSH_KEYLESS_LIVE=1` is set explicitly. A directory-wide `node --test` leaves
 * it off, so the default suite never touches the network.
 *
 * `process.argv[1]` cannot distinguish the two: `node --test test/live.test.js`
 * and `node test/live.test.js` both report the same path. Node marks the test
 * runner context instead, via `process.env.NODE_TEST_CONTEXT`.
 */
const UNDER_TEST_RUNNER = process.env.NODE_TEST_CONTEXT !== undefined;
const LIVE = process.env.DSH_KEYLESS_LIVE === "1" || !UNDER_TEST_RUNNER;
const skip = LIVE ? false : "run `npm run test:live` (needs network) to enable";

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
