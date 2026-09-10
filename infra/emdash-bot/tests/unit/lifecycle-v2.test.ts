import { describe, expect, test } from "vitest";

import { outcomeFromResult, parseCommand, resolve } from "../../.flue/lib/router.js";

describe("maintainer-facing lifecycle", () => {
	test("triages a previously unmanaged issue", () => {
		const decision = resolve({ labels: [], event: "triage", actor: "maintainer" });

		expect(decision).toMatchObject({
			kind: "transition",
			from: "unmanaged",
			to: "triaging",
			action: "investigate.triage",
		});
	});

	test("uses one work command for bugs and directed changes", () => {
		for (const labels of [
			["bot:bug", "bot:awaiting-approval"],
			["bot:enhancement", "bot:awaiting-approval"],
		]) {
			const decision = resolve({ labels, event: "work", actor: "maintainer" });
			expect(decision).toMatchObject({
				kind: "transition",
				to: "working",
				action: "investigate.work",
			});
		}
	});

	test("accepts either a fixed bug or an implemented change from a work run", () => {
		for (const result of [{ fixed: true }, { implemented: true }]) {
			expect(outcomeFromResult({ ok: true, mode: "work", result, pushed: true })).toBe(
				"agent.fix_ready",
			);
			expect(outcomeFromResult({ ok: true, mode: "work", result, pushed: false })).toBe(
				"agent.failed",
			);
		}
	});

	test("automatically escalates an eligible triage result into work", () => {
		const decision = resolve({
			labels: ["bot:task", "bot:triaging"],
			event: "agent.auto_work",
			actor: "system",
		});

		expect(decision).toMatchObject({
			kind: "transition",
			to: "working",
			action: "investigate.work",
		});
	});

	test("maps structured triage dispositions onto lifecycle events", () => {
		expect(
			outcomeFromResult({
				ok: true,
				mode: "triage",
				result: { disposition: "auto-work" },
			}),
		).toBe("agent.auto_work");
		expect(
			outcomeFromResult({
				ok: true,
				mode: "triage",
				result: { disposition: "needs-info" },
			}),
		).toBe("agent.needs_info");
		expect(
			outcomeFromResult({
				ok: true,
				mode: "triage",
				result: { disposition: "await-approval" },
			}),
		).toBe("agent.awaiting_approval");
	});

	test("requires approval for feature and sensitive-area auto-work recommendations", () => {
		for (const result of [
			{ disposition: "auto-work" as const, kind: "enhancement" as const },
			{ disposition: "auto-work" as const, kind: "bug" as const, labels: ["area/auth"] },
			{ disposition: "auto-work" as const, kind: "bug" as const, labels: ["area/ci"] },
		]) {
			expect(outcomeFromResult({ ok: true, mode: "triage", result })).toBe(
				"agent.awaiting_approval",
			);
		}
	});

	test("keeps PR repair work in the review state", () => {
		const decision = resolve({
			labels: ["bot:bug", "bot:in-review"],
			event: "pr.problems",
			arg: "Typecheck is failing",
			actor: "system",
		});

		expect(decision).toMatchObject({
			kind: "transition",
			from: "in_review",
			to: "in_review",
			action: "investigate.revise",
		});
	});

	test("retries a failed PR revision as another revision", () => {
		const decision = resolve({
			labels: ["bot:bug", "bot:needs-attention"],
			event: "retry",
			actor: "maintainer",
			retryMode: "revise",
		});

		expect(decision).toMatchObject({
			kind: "transition",
			to: "working",
			action: "investigate.revise",
		});
	});

	test("keeps legacy commands as deterministic aliases", () => {
		expect(parseCommand("@emdashbot fix")).toEqual({ event: "work", arg: null });
		expect(parseCommand("@emdashbot implement")).toEqual({ event: "work", arg: null });
		expect(parseCommand("@emdashbot repro")).toEqual({ event: "work", arg: null });
		expect(parseCommand("@emdashbot confirm")).toEqual({ event: "accept", arg: null });
		expect(parseCommand("@emdashbot reject")).toEqual({ event: "needs_changes", arg: null });
		expect(parseCommand("@emdashbot resume")).toEqual({ event: "retry", arg: null });
	});

	test("keeps rejection feedback deterministic after the candidate expires", () => {
		expect(parseCommand("@emdashbot reject look at the comments and try again")).toEqual({
			event: "needs_changes",
			arg: "look at the comments and try again",
		});
		expect(parseCommand("@emdashbot needs changes account for dense bylines")).toEqual({
			event: "needs_changes",
			arg: "account for dense bylines",
		});

		for (const state of ["reproduced", "diagnosed"] as const) {
			const decision = resolve({
				labels: ["bot:bug", `bot:${state}`],
				event: "needs_changes",
				arg: "account for dense bylines",
				actor: "maintainer",
			});
			expect(decision).toMatchObject({
				kind: "transition",
				to: "working",
				action: "investigate.work",
				arg: "account for dense bylines",
			});
		}
	});
});
