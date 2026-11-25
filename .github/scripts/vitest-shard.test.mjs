import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	assignShards,
	fileWeights,
	recordTimes,
	ShardTimesReporter,
	timedShardSequencer,
} from "./vitest-shard.mjs";

const script = fileURLToPath(new URL("./vitest-shard.mjs", import.meta.url));

function BaseSequencerStub(ctx) {
	this.ctx = ctx;
}
BaseSequencerStub.prototype.sort = async (specs) => specs.toReversed();

describe("vitest shards", () => {
	it("puts every test file in exactly one shard", () => {
		const weights = new Map([
			["a.test.ts", 1],
			["b.test.ts", 1],
			["c.test.ts", 1],
			["d.test.ts", 8],
			["e.test.ts", 9],
			["f.test.ts", 10],
		]);

		const shards = assignShards(weights, 2);

		assert.deepEqual(
			shards.flat().toSorted((a, b) => a.localeCompare(b)),
			[...weights.keys()],
		);
		assert.deepEqual(shards, [
			["a.test.ts", "b.test.ts", "c.test.ts", "f.test.ts"],
			["d.test.ts", "e.test.ts"],
		]);
	});

	it("gives the same shards whatever the input order, with tied weights too", () => {
		const entries = [
			["slow.test.ts", 120],
			["mid.test.ts", 60],
			["quick.test.ts", 5],
			["other.test.ts", 55],
		];
		const tied = ["a", "b", "c", "d", "e", "f", "g"].map((name) => [`${name}.test.ts`, 1]);

		assert.deepEqual(
			assignShards(new Map(entries), 3),
			assignShards(new Map(entries.toReversed()), 3),
		);
		assert.deepEqual(assignShards(new Map(tied), 3), assignShards(new Map(tied.toReversed()), 3));
	});

	it("weighs an unrecorded test file like the median recorded one", () => {
		const times = { "a.test.ts": 10, "b.test.ts": 20, "c.test.ts": 90 };

		const weights = fileWeights(["a.test.ts", "b.test.ts", "c.test.ts", "new.test.ts"], times);

		assert.equal(weights.get("new.test.ts"), 20);
		assert.equal(weights.get("c.test.ts"), 90);
	});

	it("records a file's whole seconds, averaged over the reports that ran it", () => {
		const previous = { "tests/kept.test.ts": 5, "tests/unseen.test.ts": 5 };
		const reports = [
			{ "tests/kept.test.ts": 4.1, "tests/new.test.ts": 0.1 },
			{ "tests/kept.test.ts": 5.9, "tests/late.test.ts": 30, "tests/broken.test.ts": "x" },
		];

		const times = recordTimes(reports, previous);

		assert.deepEqual(times, {
			"tests/kept.test.ts": 5,
			"tests/late.test.ts": 30,
			"tests/new.test.ts": 1,
			"tests/unseen.test.ts": 5,
		});
	});

	it("deals the specs out by recorded time and keeps a file's projects in one shard", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "vitest-shard-"));
		const timesFile = path.join(root, "shard-times.json");
		writeFileSync(
			timesFile,
			JSON.stringify({
				"tests/a.test.ts": 1,
				"tests/b.test.ts": 1,
				"tests/both.test.ts": 9,
				"tests/c.test.ts": 4,
			}),
		);
		const spec = (name, project) => ({
			moduleId: path.join(root, name),
			project: { name: project },
		});
		const specs = [
			spec("tests/a.test.ts", "desktop"),
			spec("tests/both.test.ts", "desktop"),
			spec("tests/b.test.ts", "desktop"),
			spec("tests/both.test.ts", "touch"),
			spec("tests/c.test.ts", "touch"),
		];
		const Sequencer = timedShardSequencer(BaseSequencerStub, timesFile);
		const shard = (index) =>
			new Sequencer({ config: { root, shard: { index, count: 2 } } }).shard(specs);

		const [first, second] = await Promise.all([shard(1), shard(2)]);

		assert.deepEqual(first, [specs[1], specs[3]]);
		assert.deepEqual(second, [specs[0], specs[2], specs[4]]);
	});

	it("runs each project's longest files first under --shard, Vitest's order otherwise", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "vitest-shard-"));
		const timesFile = path.join(root, "shard-times.json");
		writeFileSync(
			timesFile,
			JSON.stringify({
				"tests/fuzz.test.ts": 180,
				"tests/mid.test.ts": 20,
				"tests/quick.test.ts": 1,
			}),
		);
		const desktop = { name: "chromium", config: { sequence: { groupOrder: 0 } } };
		const touch = { ...desktop, name: "chromium-touch" };
		const spec = (name, specProject) => ({ moduleId: path.join(root, name), project: specProject });
		const specs = [
			spec("tests/quick.test.ts", desktop),
			spec("tests/new.test.ts", touch),
			spec("tests/mid.test.ts", desktop),
			spec("tests/fuzz.test.ts", desktop),
		];
		const Sequencer = timedShardSequencer(BaseSequencerStub, timesFile);
		const sort = (shard) => new Sequencer({ config: { root, shard } }).sort(specs);

		assert.deepEqual(await sort({ index: 1, count: 2 }), [specs[3], specs[2], specs[0], specs[1]]);
		assert.deepEqual(await sort(undefined), specs.toReversed());
	});

	it("reports each file's import, setup and run seconds, summed over its projects", () => {
		const root = mkdtempSync(path.join(tmpdir(), "vitest-shard-"));
		const testModule = (name, collectDuration, setupDuration, duration) => ({
			moduleId: path.join(root, name),
			diagnostic: () => ({ collectDuration, setupDuration, duration }),
		});
		const reporter = new ShardTimesReporter();
		reporter.onInit({ config: { root } });

		reporter.onTestRunEnd([
			testModule("tests/once.test.ts", 500, 250, 1250),
			testModule("tests/twice.test.tsx", 100, 0, 900),
			testModule("tests/twice.test.tsx", 200, 0, 1800),
		]);

		assert.deepEqual(
			JSON.parse(readFileSync(path.join(root, "vitest-timings", "shard-times.json"), "utf8")),
			{ "tests/once.test.ts": 2, "tests/twice.test.tsx": 3 },
		);
	});

	it("records times from the report files under a directory", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "vitest-shard-"));
		const timesFile = path.join(dir, "times.json");
		writeFileSync(timesFile, JSON.stringify({ "tests/old.test.ts": 1 }));
		const reports = path.join(dir, "reports", "vitest-timings-admin-2");
		mkdirSync(reports, { recursive: true });
		writeFileSync(
			path.join(reports, "shard-times.json"),
			JSON.stringify({ "tests/auth.test.ts": 2.4 }),
		);

		execFileSync(process.execPath, [
			script,
			"--record",
			path.join(dir, "reports"),
			"--times",
			timesFile,
		]);

		assert.deepEqual(JSON.parse(readFileSync(timesFile, "utf8")), {
			"tests/auth.test.ts": 2,
			"tests/old.test.ts": 1,
		});
	});
});
