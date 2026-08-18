import { describe, expect, test } from "vitest";

import {
	assertVerificationCommand,
	assertVerificationIdentity,
	findReusableVerificationRecord,
	passingVerificationRecords,
	upsertVerificationRecord,
} from "../../.flue/lib/verification.js";

describe("verification commands", () => {
	test("rejects pipelines and explicit success fallbacks that hide failures", () => {
		expect(() => assertVerificationCommand("pnpm test 2>&1 | tail -20")).toThrow(/pipeline/);
		expect(() => assertVerificationCommand("pnpm test || true")).toThrow(/pipeline/);
		expect(() => assertVerificationCommand("pnpm test; true")).toThrow(/shell control/);
		expect(() => assertVerificationCommand("pnpm test & wait")).toThrow(/shell control/);
		expect(() => assertVerificationCommand("pnpm test\ntrue")).toThrow(/shell control/);
		expect(() => assertVerificationCommand("! pnpm test")).toThrow(/negate/);
	});

	test("accepts direct checks and requires the latest result for each name to pass", () => {
		expect(() => assertVerificationCommand("pnpm --filter emdash test")).not.toThrow();
		expect(
			passingVerificationRecords([
				{ name: "tests", command: "pnpm test", exitCode: 1, candidateTreeSha: "tree" },
				{ name: "tests", command: "pnpm test", exitCode: 0, candidateTreeSha: "tree" },
				{
					name: "lint",
					command: "pnpm lint:quick",
					exitCode: 0,
					candidateTreeSha: "tree",
				},
			]),
		).toEqual([
			{ name: "tests", command: "pnpm test", exitCode: 0, candidateTreeSha: "tree" },
			{
				name: "lint",
				command: "pnpm lint:quick",
				exitCode: 0,
				candidateTreeSha: "tree",
			},
		]);
	});

	test("refuses publication when the latest named check failed", () => {
		expect(() =>
			passingVerificationRecords([
				{ name: "tests", command: "pnpm test", exitCode: 0, candidateTreeSha: "tree" },
				{ name: "tests", command: "pnpm test", exitCode: 1, candidateTreeSha: "tree" },
			]),
		).toThrow(/tests/);
	});

	test("ignores a conflicting legacy command and still requires the canonical check to pass", () => {
		expect(() =>
			passingVerificationRecords([
				{ name: "tests", command: "pnpm test", exitCode: 1, candidateTreeSha: "tree" },
				{ name: "tests", command: "true", exitCode: 0, candidateTreeSha: "tree" },
			]),
		).toThrow(/tests/);

		expect(
			passingVerificationRecords([
				{ name: "tests", command: "pnpm test", exitCode: 1, candidateTreeSha: "tree" },
				{ name: "tests", command: "true", exitCode: 0, candidateTreeSha: "tree" },
				{ name: "tests", command: "pnpm test", exitCode: 0, candidateTreeSha: "tree" },
			]),
		).toEqual([{ name: "tests", command: "pnpm test", exitCode: 0, candidateTreeSha: "tree" }]);
	});

	test("rejects command or cwd changes before they can poison verification state", () => {
		const records = [
			{
				name: "tests",
				command: "pnpm test",
				cwd: "/workspace/repo",
				exitCode: 0,
				candidateTreeSha: "tree",
			},
		];

		expect(() =>
			assertVerificationIdentity(records, {
				name: "tests",
				command: "pnpm test --runInBand",
				cwd: "/workspace/repo",
			}),
		).toThrow(/already bound/);
		expect(() =>
			assertVerificationIdentity(records, {
				name: "tests",
				command: "pnpm test",
				cwd: "/workspace/other",
			}),
		).toThrow(/already bound/);
		expect(() =>
			assertVerificationIdentity(records, {
				name: "tests",
				command: "pnpm test",
				cwd: "/workspace/repo",
			}),
		).not.toThrow();
	});

	test("reuses a passing check only on the same candidate tree", () => {
		const records = [
			{
				name: "tests",
				command: "pnpm test",
				exitCode: 0,
				candidateTreeSha: "verified-tree",
			},
		];
		const identity = { name: "tests", command: "pnpm test" };

		expect(findReusableVerificationRecord(records, identity, "verified-tree")).toEqual(records[0]);
		expect(findReusableVerificationRecord(records, identity, "changed-tree")).toBeNull();
		expect(
			findReusableVerificationRecord([{ ...records[0], exitCode: 1 }], identity, "verified-tree"),
		).toBeNull();
	});

	test("upserts one record per name and removes conflicting legacy rows", () => {
		const replacement = {
			name: "tests",
			command: "pnpm test",
			exitCode: 0,
			candidateTreeSha: "new-tree",
		};

		expect(
			upsertVerificationRecord(
				[
					{ name: "tests", command: "pnpm test", exitCode: 1, candidateTreeSha: "old" },
					{ name: "tests", command: "true", exitCode: 0, candidateTreeSha: "old" },
					{ name: "lint", command: "pnpm lint", exitCode: 0, candidateTreeSha: "old" },
				],
				replacement,
			),
		).toEqual([
			{ name: "lint", command: "pnpm lint", exitCode: 0, candidateTreeSha: "old" },
			replacement,
		]);
	});

	test("does not publish a candidate changed after verification", () => {
		expect(() =>
			passingVerificationRecords(
				[
					{
						name: "tests",
						command: "pnpm test",
						exitCode: 0,
						candidateTreeSha: "verified-tree",
					},
				],
				"published-tree",
			),
		).toThrow(/candidate changed/);
	});
});
