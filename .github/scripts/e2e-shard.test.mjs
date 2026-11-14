import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { assignShards, listSpecFiles, recordTimes, specWeights } from "./e2e-shard.mjs";

const script = fileURLToPath(new URL("./e2e-shard.mjs", import.meta.url));
const EMPTY_SHARD = /has no spec files/;
const OUT_OF_RANGE = /out of range/;
const UNKNOWN_TARGET = /unknown target/;
const DUPLICATE_TITLE = /duplicate test title "saves"/;

function listReport(files, rootDir = "/repo/e2e/tests") {
	return { config: { rootDir }, suites: files.map((file) => ({ title: file, file })) };
}

function runReport(durationsByFile) {
	return {
		config: { rootDir: "/repo/e2e/tests" },
		suites: Object.entries(durationsByFile).map(([file, durations]) => ({
			file,
			specs: [{ tests: [{ results: durations.slice(0, 1).map((duration) => ({ duration })) }] }],
			suites: [
				{
					specs: [{ tests: [{ results: durations.slice(1).map((duration) => ({ duration })) }] }],
				},
			],
		})),
	};
}

function workspace(t, times) {
	const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-shard-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const timesFile = path.join(cwd, "times.json");
	writeFileSync(timesFile, JSON.stringify(times));
	return { cwd, timesFile };
}

describe("e2e shards", () => {
	it("puts every spec file in exactly one shard", () => {
		const weights = new Map([
			["a.spec.ts", 10],
			["b.spec.ts", 9],
			["c.spec.ts", 8],
			["d.spec.ts", 1],
			["e.spec.ts", 1],
			["f.spec.ts", 1],
		]);

		const shards = assignShards(weights, 2);

		assert.deepEqual(
			shards.flat().toSorted((a, b) => a.localeCompare(b)),
			[...weights.keys()],
		);
		assert.deepEqual(shards, [
			["a.spec.ts", "d.spec.ts", "e.spec.ts", "f.spec.ts"],
			["b.spec.ts", "c.spec.ts"],
		]);
	});

	it("gives the same shards whatever the input order", () => {
		const entries = [
			["slow.spec.ts", 120],
			["mid.spec.ts", 60],
			["quick.spec.ts", 5],
			["other.spec.ts", 55],
			["twin.spec.ts", 5],
		];

		const forward = assignShards(new Map(entries), 3);
		const backward = assignShards(new Map(entries.toReversed()), 3);

		assert.deepEqual(forward, backward);
	});

	it("weighs an unrecorded spec file like the median recorded one", () => {
		const times = {
			"a.spec.ts": { node: 10, cloudflare: 30 },
			"b.spec.ts": { node: 20, cloudflare: 40 },
			"c.spec.ts": { node: 90, cloudflare: 50 },
		};

		const node = specWeights(["a.spec.ts", "b.spec.ts", "c.spec.ts", "new.spec.ts"], times, "node");
		const both = specWeights(["a.spec.ts", "new.spec.ts"], times, "both");

		assert.equal(node.get("new.spec.ts"), 20);
		assert.equal(node.get("c.spec.ts"), 90);
		assert.equal(both.get("a.spec.ts"), 40);
		assert.equal(both.get("new.spec.ts"), 10 + 30);
	});

	it("names spec files relative to the working directory", () => {
		const files = listSpecFiles(
			listReport(["auth.spec.ts", "auth.spec.ts", "menus.spec.ts"]),
			"/repo",
		);

		assert.deepEqual(files, [
			{ name: "auth.spec.ts", arg: path.join("e2e", "tests", "auth.spec.ts") },
			{ name: "menus.spec.ts", arg: path.join("e2e", "tests", "menus.spec.ts") },
		]);
	});

	it("fails with Playwright's errors when the spec files didn't load", () => {
		const report = {
			...listReport([]),
			errors: [
				{ message: 'Error: duplicate test title "saves", first declared in auth.spec.ts:4' },
			],
		};

		assert.throws(() => listSpecFiles(report, "/repo"), DUPLICATE_TITLE);
	});

	it("records a file's whole seconds per target, averaged over the reports that ran it", () => {
		const previous = {
			"kept.spec.ts": { node: 5, cloudflare: 6 },
			"unseen.spec.ts": { node: 5, cloudflare: 6 },
		};
		const reports = [
			{ target: "node", report: runReport({ "kept.spec.ts": [1500, 2600], "new.spec.ts": [100] }) },
			{ target: "node", report: runReport({ "kept.spec.ts": [5900], "late.spec.ts": [30000] }) },
		];

		const times = recordTimes(reports, previous);

		assert.deepEqual(times, {
			"kept.spec.ts": { node: 5, cloudflare: 6 },
			"late.spec.ts": { node: 30 },
			"new.spec.ts": { node: 1 },
			"unseen.spec.ts": { node: 5, cloudflare: 6 },
		});
	});

	it("prints one shard's spec files from a list report on stdin", (t) => {
		const { cwd, timesFile } = workspace(t, {
			"accessibility.spec.ts": { node: 100, cloudflare: 120 },
			"menus.spec.ts": { node: 90, cloudflare: 110 },
		});
		const report = listReport(
			["accessibility.spec.ts", "auth.spec.ts", "menus.spec.ts"],
			path.join(cwd, "e2e", "tests"),
		);
		const run = (shard) =>
			execFileSync(
				process.execPath,
				[script, "--shard", shard, "--target", "both", "--times", timesFile],
				{ input: JSON.stringify(report), encoding: "utf8", cwd },
			);

		const printed = [run("1/2"), run("2/2")].map((output) => output.trim().split(" "));

		assert.deepEqual(printed, [
			["e2e/tests/accessibility.spec.ts", "e2e/tests/menus.spec.ts"],
			["e2e/tests/auth.spec.ts"],
		]);
	});

	it("fails instead of printing an empty shard or an unknown target", (t) => {
		const { timesFile } = workspace(t, {});
		const report = JSON.stringify(listReport(["auth.spec.ts"]));
		const run = (args) =>
			execFileSync(process.execPath, [script, ...args, "--times", timesFile], {
				input: report,
				encoding: "utf8",
				stdio: "pipe",
			});

		assert.throws(() => run(["--shard", "2/2", "--target", "both"]), EMPTY_SHARD);
		assert.throws(() => run(["--shard", "3/2", "--target", "both"]), OUT_OF_RANGE);
		assert.throws(() => run(["--shard", "1/1", "--target", "deno"]), UNKNOWN_TARGET);
	});

	it("records times from the report files under a directory", (t) => {
		const { cwd, timesFile } = workspace(t, { "old.spec.ts": { node: 1, cloudflare: 1 } });
		const reports = path.join(cwd, "reports", "e2e-timings-3");
		mkdirSync(reports, { recursive: true });
		writeFileSync(
			path.join(reports, "cloudflare.json"),
			JSON.stringify(runReport({ "auth.spec.ts": [2400] })),
		);

		execFileSync(process.execPath, [
			script,
			"--record",
			path.join(cwd, "reports"),
			"--times",
			timesFile,
		]);

		assert.deepEqual(JSON.parse(readFileSync(timesFile, "utf8")), {
			"auth.spec.ts": { cloudflare: 2 },
			"old.spec.ts": { node: 1, cloudflare: 1 },
		});
	});
});
