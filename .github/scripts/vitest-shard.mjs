import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const TIMES_FILE = new URL("../../packages/core/tests/shard-times.json", import.meta.url);

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function median(values) {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted.length === 0 ? 1 : sorted[Math.floor(sorted.length / 2)];
}

/**
 * Seconds per test file. A file the times don't know gets the median of the
 * known files, so a new test file is placed as a typical one until the
 * times are recorded again.
 */
export function fileWeights(names, times) {
	const known = names.map((name) => times[name]).filter((seconds) => Number.isFinite(seconds));
	const fallback = median(known);
	return new Map(
		names.map((name) => [name, Number.isFinite(times[name]) ? times[name] : fallback]),
	);
}

/**
 * Splits test files into `total` groups whose summed weights are as even as
 * greedy longest-first placement makes them. The result depends only on the
 * names and weights, not on the input order.
 */
export function assignShards(weights, total) {
	const ordered = [...weights].toSorted(
		([nameA, secondsA], [nameB, secondsB]) => secondsB - secondsA || byName(nameA, nameB),
	);
	const shards = Array.from({ length: total }, () => ({ seconds: 0, names: [] }));
	for (const [name, seconds] of ordered) {
		const lightest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min));
		lightest.names.push(name);
		lightest.seconds += seconds;
	}
	return shards.map((shard) => shard.names.toSorted(byName));
}

/**
 * Seconds per test file from the files ShardTimesReporter writes, averaged
 * over the reports that ran the file and merged over the previous times. A
 * file the reports don't cover keeps its previous value, so a partial
 * download can't erase the rest; a stale entry costs nothing because Vitest
 * decides which files exist.
 */
export function recordTimes(reports, previous = {}) {
	const samples = {};
	for (const report of reports) {
		for (const [name, seconds] of Object.entries(report)) {
			if (Number.isFinite(seconds)) (samples[name] ??= []).push(seconds);
		}
	}
	const times = {};
	for (const name of Object.keys({ ...previous, ...samples }).toSorted(byName)) {
		const measured = samples[name];
		const seconds = measured
			? measured.reduce((sum, value) => sum + value, 0) / measured.length
			: previous[name];
		if (Number.isFinite(seconds)) times[name] = Math.max(1, Math.round(seconds));
	}
	return times;
}

function readReports(dir) {
	const reports = [];
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const report = JSON.parse(readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
		if (report && typeof report === "object" && !Array.isArray(report)) reports.push(report);
	}
	return reports;
}

function main() {
	const args = process.argv.slice(2);
	const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
	if (args.includes("--help") || !option("--record")) {
		process.stdout.write(
			[
				"Usage: vitest-shard.mjs --record <dir> [--times <file>]",
				"  updates packages/core/tests/shard-times.json from the vitest-timings reports under <dir>,",
				"  for example after: gh run download <run-id> -p 'vitest-timings-*' -D <dir>",
				"",
			].join("\n"),
		);
		return;
	}
	const timesFile = option("--times") ?? TIMES_FILE;
	const reports = readReports(option("--record"));
	if (reports.length === 0)
		throw new Error(`no vitest-timings reports under ${option("--record")}`);
	const previous = JSON.parse(readFileSync(timesFile, "utf8"));
	const times = recordTimes(reports, previous);
	writeFileSync(timesFile, `${JSON.stringify(times, null, "\t")}\n`);
	process.stdout.write(
		`recorded ${Object.keys(times).length} test files from ${reports.length} reports\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
