#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const TIMES_FILE = new URL("./e2e-shard-times.json", import.meta.url);
export const TARGETS = ["node", "cloudflare"];

const REPORT_FILE_PATTERN = /^(node|cloudflare)\.json$/;
const SHARD_PATTERN = /^(\d+)\/(\d+)$/;

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Spec files of a Playwright JSON report, keyed as the report names them
 * (relative to the config's root directory), with the path to pass on the
 * command line. A spec file that fails to load leaves Playwright's report
 * with no suites at all, so the report's errors are thrown instead.
 */
export function listSpecFiles(report, cwd = process.cwd()) {
	if (report.errors?.length > 0) {
		const messages = report.errors.map((error) => error.message).join("\n");
		throw new Error(`playwright test --list failed:\n${messages}`);
	}
	const seen = new Set();
	const files = [];
	for (const suite of report.suites) {
		if (seen.has(suite.file)) continue;
		seen.add(suite.file);
		files.push({
			name: suite.file,
			arg: path.relative(cwd, path.resolve(report.config.rootDir, suite.file)),
		});
	}
	return files;
}

function median(values) {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted.length === 0 ? 1 : sorted[Math.floor(sorted.length / 2)];
}

/**
 * Seconds per spec file for one target, or the sum over both for `both`.
 * A file the times don't know gets the median of the known files, so a new
 * spec is placed as an average one until the times are recorded again.
 */
export function specWeights(names, times, target) {
	const targets = target === "both" ? TARGETS : [target];
	const weights = new Map(names.map((name) => [name, 0]));
	for (const current of targets) {
		const known = names
			.map((name) => times[name]?.[current])
			.filter((seconds) => Number.isFinite(seconds));
		const fallback = median(known);
		for (const name of names) {
			const seconds = times[name]?.[current];
			weights.set(name, weights.get(name) + (Number.isFinite(seconds) ? seconds : fallback));
		}
	}
	return weights;
}

/**
 * Splits spec files into `total` groups whose summed weights are as even as
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

function sumDurations(suite, totals) {
	for (const spec of suite.specs ?? []) {
		for (const test of spec.tests ?? []) {
			for (const result of test.results ?? []) totals.seconds += result.duration / 1000;
		}
	}
	for (const child of suite.suites ?? []) sumDurations(child, totals);
}

/**
 * Seconds per spec file and target from Playwright JSON reports of test runs,
 * averaged over the reports that ran the file and merged over the previous
 * times. A spec file or target the reports don't cover keeps its previous
 * values, so a partial download can't erase the rest.
 */
export function recordTimes(reports, previous = {}) {
	const samples = {};
	for (const { target, report } of reports) {
		for (const suite of report.suites) {
			const totals = { seconds: 0 };
			sumDurations(suite, totals);
			((samples[suite.file] ??= {})[target] ??= []).push(totals.seconds);
		}
	}
	const times = {};
	for (const name of Object.keys({ ...previous, ...samples }).toSorted(byName)) {
		times[name] = {};
		for (const target of TARGETS) {
			const measured = samples[name]?.[target];
			const seconds = measured
				? measured.reduce((sum, value) => sum + value, 0) / measured.length
				: previous[name]?.[target];
			if (Number.isFinite(seconds)) times[name][target] = Math.max(1, Math.round(seconds));
		}
	}
	return times;
}

function readReports(dir) {
	const reports = [];
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const match = REPORT_FILE_PATTERN.exec(entry.name);
		if (!match || !entry.isFile()) continue;
		const file = path.join(entry.parentPath, entry.name);
		reports.push({ target: match[1], report: JSON.parse(readFileSync(file, "utf8")) });
	}
	return reports;
}

function parseShard(value) {
	const match = SHARD_PATTERN.exec(value ?? "");
	if (!match) throw new Error(`--shard expects <index>/<total>, got "${value}"`);
	const index = Number(match[1]);
	const total = Number(match[2]);
	if (index < 1 || index > total) throw new Error(`shard ${value} is out of range`);
	return { index, total };
}

async function readStdin() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	return input;
}

async function main() {
	const args = process.argv.slice(2);
	const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
	if (args.includes("--help")) {
		process.stdout.write(
			[
				"Usage:",
				"  playwright test --list --reporter=json | e2e-shard.mjs --shard <index>/<total> --target node|cloudflare|both",
				"      prints the spec files of that shard, balanced by recorded duration",
				"  e2e-shard.mjs --record <dir>",
				"      updates e2e-shard-times.json from the node.json and cloudflare.json reports under <dir>",
				"  --times <file>   reads and writes that file instead of e2e-shard-times.json",
				"",
			].join("\n"),
		);
		return;
	}

	const timesFile = option("--times") ?? TIMES_FILE;
	const recordDir = option("--record");
	if (recordDir) {
		const reports = readReports(recordDir);
		if (reports.length === 0)
			throw new Error(`no node.json or cloudflare.json reports under ${recordDir}`);
		const previous = JSON.parse(readFileSync(timesFile, "utf8"));
		const times = recordTimes(reports, previous);
		writeFileSync(timesFile, `${JSON.stringify(times, null, "\t")}\n`);
		process.stdout.write(
			`recorded ${Object.keys(times).length} spec files from ${reports.length} reports\n`,
		);
		return;
	}

	const { index, total } = parseShard(option("--shard"));
	const target = option("--target") ?? "both";
	if (target !== "both" && !TARGETS.includes(target)) throw new Error(`unknown target "${target}"`);
	const files = listSpecFiles(JSON.parse(await readStdin()));
	const times = JSON.parse(readFileSync(timesFile, "utf8"));
	const weights = specWeights(
		files.map((file) => file.name),
		times,
		target,
	);
	const names = assignShards(weights, total)[index - 1];
	if (names.length === 0) throw new Error(`shard ${index}/${total} has no spec files`);
	const argByName = new Map(files.map((file) => [file.name, file.arg]));
	process.stdout.write(`${names.map((name) => argByName.get(name)).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
