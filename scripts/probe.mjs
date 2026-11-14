#!/usr/bin/env node
/**
 * Health probe for the keyless backend chain.
 *
 * The default chain order is a snapshot of what worked when it was written.
 * Public endpoints drift — they get rate limited, change shape, or disappear —
 * so that snapshot goes stale. This script re-measures every backend and tells
 * you whether the configured order still reflects reality.
 *
 * **It is deliberately frugal.** Flooding these services is what makes them
 * start refusing this network in the first place: a 60-request burst is enough
 * to earn a multi-hour block. Defaults reflect that.
 *
 * Usage:
 *   node scripts/probe.mjs                 # every backend, 2 queries each
 *   node scripts/probe.mjs --queries 3     # a bit more confidence, more load
 *   node scripts/probe.mjs --only mwmbl,exa
 *   node scripts/probe.mjs --json          # machine-readable
 *   node scripts/probe.mjs --timeout 25000
 *
 * Exit code is 0 when every probed backend answered at least once, 1 otherwise,
 * so this can gate a scheduled job. It never writes anything.
 *
 * This file is a development tool and is not part of the published bundle.
 *
 * @module dsh-keyless-search/scripts/probe
 */

import { BACKENDS, DEFAULT_BACKENDS } from "../lib/index.js";

/**
 * Queries chosen to exercise the shapes these backends actually see: a
 * developer question, a non-English question, and a factual one. Small on
 * purpose.
 */
const QUERIES = [
	"node.js fetch timeout",
	"cara membuat nasi goreng",
	"quantum entanglement explained",
];

/** Parse `--flag value` and `--flag` pairs without pulling in a dependency. */
function parseArgs(argv) {
	const options = { queries: 2, only: undefined, json: false, timeout: 25_000 };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--queries") options.queries = Number(argv[++index]);
		else if (arg === "--timeout") options.timeout = Number(argv[++index]);
		else if (arg === "--only") options.only = String(argv[++index] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
		else if (arg === "--help" || arg === "-h") options.help = true;
		else {
			console.error(`probe: unknown argument ${JSON.stringify(arg)} (try --help)`);
			process.exit(2);
		}
	}
	if (!Number.isFinite(options.queries) || options.queries < 1) options.queries = 1;
	if (!Number.isFinite(options.timeout) || options.timeout < 1_000) options.timeout = 25_000;
	return options;
}

/**
 * Probe one backend over a few queries.
 * @param {{id: string, label: string, kind: string, search: Function}} backend
 * @param {string[]} queries - queries to try.
 * @param {number} timeoutMs - per-request timeout.
 * @returns {Promise<{id: string, kind: string, ok: number, empty: number, fail: number, latencies: number[], error?: string}>}
 */
async function probeBackend(backend, queries, timeoutMs) {
	const result = { id: backend.id, kind: backend.kind, ok: 0, empty: 0, fail: 0, latencies: [], error: undefined };
	for (const query of queries) {
		const startedAt = Date.now();
		try {
			const sources = await backend.search(query, { maxResults: 5, timeoutMs });
			result.latencies.push(Date.now() - startedAt);
			if (Array.isArray(sources) && sources.length > 0) result.ok += 1;
			else result.empty += 1;
		} catch (error) {
			result.fail += 1;
			// Keep the first failure reason; later ones are usually the same block.
			result.error ??= error instanceof Error ? error.message : String(error);
		}
		// Space requests out. These are volunteer/low-quota services.
		await new Promise((resolve) => setTimeout(resolve, 750));
	}
	return result;
}

/** Median of a numeric list, or undefined when empty. */
function median(values) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** One-line verdict for a probe result. */
function verdict(result) {
	if (result.ok > 0 && result.fail === 0 && result.empty === 0) return "healthy";
	if (result.ok > 0) return "degraded";
	if (result.empty > 0) return "empty";
	return "down";
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
	console.log(
		[
			"Usage: node scripts/probe.mjs [options]",
			"",
			"  --queries <n>   queries per backend (default 2; higher = more load on free services)",
			"  --only <ids>    comma-separated backend ids to probe",
			"  --timeout <ms>  per-request timeout (default 25000)",
			"  --json          print JSON instead of a table",
			"",
			"Backends: " + Object.keys(BACKENDS).join(", "),
		].join("\n"),
	);
	process.exit(0);
}

const ids = options.only ?? DEFAULT_BACKENDS;
const unknown = ids.filter((id) => BACKENDS[id] === undefined);
if (unknown.length > 0) {
	console.error(`probe: unknown backend(s): ${unknown.join(", ")}`);
	console.error(`probe: known backends: ${Object.keys(BACKENDS).join(", ")}`);
	process.exit(2);
}

const queries = QUERIES.slice(0, options.queries);
const startedAt = new Date();

if (!options.json) {
	console.log(`Probing ${ids.length} backend(s) x ${queries.length} quer${queries.length === 1 ? "y" : "ies"}...`);
	console.log(`Started ${startedAt.toISOString()}\n`);
}

const results = [];
for (const id of ids) {
	const backend = BACKENDS[id];
	if (!options.json) process.stdout.write(`  ${id.padEnd(12)} `);
	const result = await probeBackend(backend, queries, options.timeout);
	results.push(result);
	if (!options.json) {
		const elapsed = median(result.latencies);
		console.log(
			`${verdict(result).padEnd(9)} ok=${result.ok} empty=${result.empty} fail=${result.fail}` +
				(elapsed === undefined ? "" : ` p50=${elapsed}ms`),
		);
	}
}

if (options.json) {
	console.log(
		JSON.stringify(
			{
				probedAt: startedAt.toISOString(),
				queries,
				results: results.map((result) => ({ ...result, verdict: verdict(result), p50: median(result.latencies) })),
			},
			null,
			2,
		),
	);
} else {
	console.log("\nMarkdown (paste into the README status table):\n");
	console.log("| Backend | Kind | Verdict | p50 | Details |");
	console.log("|---|---|---|---|---|");
	for (const result of results) {
		const elapsed = median(result.latencies);
		const detail = result.error ? result.error.slice(0, 60).replaceAll("|", "\\|") : "";
		console.log(
			`| ${result.id} | ${result.kind} | ${verdict(result)} | ${elapsed === undefined ? "-" : `${elapsed}ms`} | ${detail} |`,
		);
	}
	console.log(`\nMeasured ${startedAt.toISOString()}`);

	const down = results.filter((result) => verdict(result) === "down");
	if (down.length > 0) {
		console.log(`\n${down.length} backend(s) down: ${down.map((result) => result.id).join(", ")}`);
		console.log("Consider moving them later in `backends`, or removing them.");
	}
	const healthy = results.filter((result) => verdict(result) === "healthy");
	const order = results.map((result) => result.id);
	const firstHealthy = healthy[0];
	if (firstHealthy !== undefined && order.indexOf(firstHealthy.id) > 0) {
		console.log(
			`\nNote: ${firstHealthy.id} is healthy but sits at position ${order.indexOf(firstHealthy.id) + 1}. ` +
				`Backends ahead of it are wasting a request on every search.`,
		);
	}
}

process.exit(results.every((result) => result.ok > 0) ? 0 : 1);
