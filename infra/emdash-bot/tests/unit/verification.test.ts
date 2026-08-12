import { describe, expect, test } from "vitest";

import {
	assertVerificationCommand,
	passingVerificationRecords,
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

	test("does not let a failed named check be replaced by a different command", () => {
		expect(() =>
			passingVerificationRecords([
				{ name: "tests", command: "pnpm test", exitCode: 1, candidateTreeSha: "tree" },
				{ name: "tests", command: "true", exitCode: 0, candidateTreeSha: "tree" },
			]),
		).toThrow(/changed command/);
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
