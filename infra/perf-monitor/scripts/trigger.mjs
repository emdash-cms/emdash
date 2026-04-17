#!/usr/bin/env node
/**
 * Ad-hoc perf-monitor trigger.
 *
 * Fires POST https://perf.emdashcms.com/api/trigger via Cloudflare Access.
 * The endpoint is gated by Access, so authentication is handled by
 * `cloudflared access` (first invocation opens a browser; subsequent
 * invocations reuse the token until session expiry).
 *
 * Usage:
 *   pnpm trigger                          # default: runs probes, does NOT record
 *   pnpm trigger -- --store               # persist with source=manual
 *   pnpm trigger -- --store --note "..."  # persist with a note
 *   pnpm trigger -- --sha abc1234         # attach a SHA (requires --store to persist)
 *   pnpm trigger -- --pr 123              # attach a PR number (requires --store)
 *
 * The default is ephemeral -- probes run for real but nothing is written
 * to the database. Pass --store to persist the run as source=manual
 * (excluded from the graph and summary cards, visible in the results
 * table). Other flags like --note/--sha/--pr only have an effect when
 * combined with --store.
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const ENDPOINT = process.env.PERF_ENDPOINT ?? "https://perf.emdashcms.com/api/trigger";

function die(msg, code = 1) {
	console.error(`trigger: ${msg}`);
	process.exit(code);
}

// pnpm passes a literal `--` token through when users invoke `pnpm trigger -- --note foo`.
// parseArgs treats that as a positional and throws in strict mode. Strip any `--` tokens.
const argv = process.argv.slice(2).filter((a) => a !== "--");

if (argv.includes("-h") || argv.includes("--help")) {
	console.log(
		"Usage: pnpm trigger [-- --store] [--note <string>] [--sha <sha>] [--pr <number>]\n" +
			"\n" +
			"Runs an ad-hoc perf measurement against the live demo.\n" +
			"\n" +
			"Default is ephemeral: probes run for real but nothing is written to\n" +
			"the database. Pass --store to persist the run as source=manual\n" +
			"(excluded from the graph and summary cards, visible in the results\n" +
			"table). --note/--sha/--pr only take effect together with --store.",
	);
	process.exit(0);
}

const { values } = parseArgs({
	args: argv,
	options: {
		store: { type: "boolean" },
		note: { type: "string" },
		sha: { type: "string" },
		pr: { type: "string" },
	},
	allowPositionals: false,
	strict: true,
});

// Default is ephemeral (not persisted). --store flips that.
const ephemeral = !values.store;

const body = {};
if (ephemeral) body.ephemeral = true;
if (values.note) body.note = values.note;
if (values.sha) body.sha = values.sha;
if (values.pr) {
	const n = Number.parseInt(values.pr, 10);
	if (!Number.isInteger(n) || n <= 0) die(`--pr must be a positive integer, got ${values.pr}`);
	body.prNumber = n;
}

// Warn loudly if someone passed metadata flags without --store: those fields
// only make it into the DB, and we're not writing to the DB in ephemeral mode.
if (ephemeral && (values.note || values.sha || values.pr)) {
	console.warn(
		"trigger: warning: --note/--sha/--pr have no effect without --store (ephemeral mode discards everything)",
	);
}

const label = values.note ? ` (${values.note})` : "";
const mode = ephemeral ? " [ephemeral, not recorded]" : "";
console.log(`trigger: firing against ${ENDPOINT}${label}${mode}`);
console.log("trigger: this typically takes 20-40s while probes run...");

// `cloudflared access curl` passes everything after the URL straight to curl.
// The URL must come first, immediately after `curl` (no `--` separator).
const result = spawnSync(
	"cloudflared",
	[
		"access",
		"curl",
		ENDPOINT,
		"-sS",
		"-X",
		"POST",
		"-H",
		"content-type: application/json",
		"--data",
		JSON.stringify(body),
	],
	{ encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
);

if (result.error) {
	if (result.error.code === "ENOENT") {
		die(
			"cloudflared is not installed or not on PATH.\n" +
				"       Install: brew install cloudflared   (or see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)\n" +
				"       Then run this command again to complete first-time browser login.",
		);
	}
	die(`cloudflared failed: ${result.error.message}`);
}
if (result.status !== 0) die(`cloudflared exited ${result.status}`);

let parsed;
try {
	parsed = JSON.parse(result.stdout);
} catch {
	die(`unexpected non-JSON response:\n${result.stdout}`);
}

if (parsed.error) die(`server error: ${parsed.error}`);

if (parsed.ephemeral) {
	console.log(
		`trigger: measured ${parsed.results?.length ?? 0} samples in ${parsed.durationMs}ms (ephemeral, nothing recorded)`,
	);
} else {
	console.log(
		`trigger: recorded ${parsed.inserted} samples in ${parsed.durationMs}ms (source=manual)`,
	);
}

// Pretty-print a per-route table. Layout per route:
//
//   /
//     REGION  COLD     WARM     P95      COLO    TIMINGS
//     use     1234ms   123ms    156ms    IAD     render=42ms  mw=58ms
//     euw     ...
//
// Column widths are computed from the rows we're about to print so that
// unusually slow runs don't break alignment, and timing columns only
// appear if at least one row has timings.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

const formatMs = (n) => (n == null ? "-" : `${Math.round(n)}ms`);

// Group results by route, preserving insertion order
const byRoute = new Map();
for (const r of parsed.results ?? []) {
	if (!byRoute.has(r.route)) byRoute.set(r.route, []);
	byRoute.get(r.route).push(r);
}

for (const [route, rows] of byRoute) {
	console.log(`\n  ${bold(route)}`);

	// Collect the union of timing names present on this route across BOTH
	// cold and warm snapshots so every row gets a cell in each column,
	// even when a particular probe response lacked some entries.
	// Warm timings are prefixed with "w." in the column header to make
	// the split obvious (cold and warm snapshots share the same metric
	// names — "render", "rt", "mw" — so we'd collide otherwise).
	const coldNames = [];
	const warmNames = [];
	const seenCold = new Set();
	const seenWarm = new Set();
	for (const r of rows) {
		if (r.coldServerTimings) {
			for (const name of Object.keys(r.coldServerTimings)) {
				if (!seenCold.has(name)) {
					seenCold.add(name);
					coldNames.push(name);
				}
			}
		}
		if (r.warmServerTimings) {
			for (const name of Object.keys(r.warmServerTimings)) {
				if (!seenWarm.has(name)) {
					seenWarm.add(name);
					warmNames.push(name);
				}
			}
		}
	}

	// Build row cells. Column order: region, cold, warm, p95, colo,
	// then all cold timings (cold-* intent), then warm timings.
	// Cold timings keep their bare names for backwards-compatible output;
	// warm timings get a "w." prefix.
	const warmHeaders = warmNames.map((n) => `w.${n}`);
	const header = ["region", "cold", "warm", "p95", "colo", ...coldNames, ...warmHeaders];
	const tableRows = rows.map((r) => {
		const cells = [
			r.region,
			formatMs(r.coldTtfbMs),
			formatMs(r.warmTtfbMs),
			formatMs(r.p95TtfbMs),
			r.cfColo ?? "-",
		];
		for (const name of coldNames) {
			const t = r.coldServerTimings?.[name];
			cells.push(t ? formatMs(t.dur) : "-");
		}
		for (const name of warmNames) {
			const t = r.warmServerTimings?.[name];
			cells.push(t ? formatMs(t.dur) : "-");
		}
		return cells;
	});

	// Column widths = max(header, body) per column.
	const widths = header.map((h, col) =>
		Math.max(h.length, ...tableRows.map((cells) => cells[col].length)),
	);

	const padCell = (s, col) => s.padEnd(widths[col]);
	const joinRow = (cells) => cells.map(padCell).join("  ");

	console.log(`    ${dim(joinRow(header))}`);
	for (const cells of tableRows) {
		console.log(`    ${joinRow(cells)}`);
	}
}
