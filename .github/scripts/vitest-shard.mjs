import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const relativeName = (root, file) => path.relative(root, file).split(path.sep).join("/");

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
 * download can't erase the rest.
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

/**
 * A Vitest sequencer that deals the test files out to `--shard` groups by the
 * seconds recorded in `timesFile`, not by count. Pass the package's own
 * `BaseSequencer` from `vitest/node`. A file that runs in several projects
 * stays in one group.
 */
export function timedShardSequencer(BaseSequencer, timesFile) {
	const times = JSON.parse(readFileSync(timesFile, "utf8"));
	return class TimedShardSequencer extends BaseSequencer {
		async shard(specs) {
			const { root, shard } = this.ctx.config;
			const specsByName = new Map();
			for (const spec of specs) {
				const name = relativeName(root, spec.moduleId);
				specsByName.set(name, [...(specsByName.get(name) ?? []), spec]);
			}
			const weights = fileWeights([...specsByName.keys()], times);
			return assignShards(weights, shard.count)[shard.index - 1].flatMap((name) =>
				specsByName.get(name),
			);
		}

		/**
		 * With `--shard`, runs each project's files longest first. Vitest hands
		 * files to free workers in this order, so a long file that starts last
		 * would run alone after every other file has finished.
		 */
		async sort(specs) {
			// oxlint-disable-next-line unicorn/no-array-sort -- Vitest's sequencer method, not Array#sort
			if (!this.ctx.config.shard) return super.sort(specs);
			const { root } = this.ctx.config;
			const names = new Map(specs.map((spec) => [spec, relativeName(root, spec.moduleId)]));
			const weights = fileWeights([...new Set(names.values())], times);
			return specs.toSorted(
				(a, b) =>
					a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder ||
					byName(a.project.name, b.project.name) ||
					weights.get(names.get(b)) - weights.get(names.get(a)) ||
					byName(names.get(a), names.get(b)),
			);
		}
	};
}

/**
 * A Vitest reporter that writes the seconds each test file took to import,
 * set up and run, the measure a times file holds, to
 * vitest-timings/shard-times.json under the package. A file that runs in
 * several projects gets the sum of its runs.
 */
export class ShardTimesReporter {
	onInit(vitest) {
		this.root = vitest.config.root;
	}

	onTestRunEnd(testModules) {
		const times = {};
		for (const testModule of testModules) {
			const { collectDuration, setupDuration, duration } = testModule.diagnostic();
			const name = relativeName(this.root, testModule.moduleId);
			times[name] = (times[name] ?? 0) + (collectDuration + setupDuration + duration) / 1000;
		}
		const file = path.join(this.root, "vitest-timings", "shard-times.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(times, null, "\t")}\n`);
	}
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
				"Usage: vitest-shard.mjs --record <dir> --times <file>",
				"  updates a package's times file from the vitest-timings reports under <dir>, for example:",
				"  gh run download <run-id> -p 'vitest-timings-admin-*' -D <dir>",
				"  vitest-shard.mjs --record <dir> --times packages/admin/tests/shard-times.json",
				"",
			].join("\n"),
		);
		return;
	}
	const timesFile = option("--times");
	if (!timesFile) throw new Error("--times <file> must name the times file to update");
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
