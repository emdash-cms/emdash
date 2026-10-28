import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { assignShards, fileWeights, recordTimes } from "./vitest-shard.mjs";

const script = fileURLToPath(new URL("./vitest-shard.mjs", import.meta.url));

describe("vitest shards", () => {
	it("puts every test file in exactly one shard", () => {
		const weights = new Map([
			["a.test.ts", 10],
			["b.test.ts", 9],
			["c.test.ts", 8],
			["d.test.ts", 1],
			["e.test.ts", 1],
			["f.test.ts", 1],
		]);

		const shards = assignShards(weights, 2);

		assert.deepEqual(
			shards.flat().toSorted((a, b) => a.localeCompare(b)),
			[...weights.keys()],
		);
		assert.deepEqual(shards, [
			["a.test.ts", "d.test.ts", "e.test.ts", "f.test.ts"],
			["b.test.ts", "c.test.ts"],
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

	it("records times from the report files under a directory", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "vitest-shard-"));
		const timesFile = path.join(dir, "times.json");
		writeFileSync(timesFile, JSON.stringify({ "tests/old.test.ts": 1 }));
		const reports = path.join(dir, "reports", "vitest-timings-3");
		mkdirSync(reports, { recursive: true });
		writeFileSync(path.join(reports, "unit.json"), JSON.stringify({ "tests/auth.test.ts": 2.4 }));

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
