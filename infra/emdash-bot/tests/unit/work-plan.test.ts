import { describe, expect, test } from "vitest";

import {
	renderPreparingWorkPlanComment,
	renderWorkPlanComment,
	updateWorkPlan,
} from "../../.flue/lib/work-plan.js";

describe("agent work plans", () => {
	const initial = {
		summary: "Resolve the conflicts against current main.",
		steps: [
			{ id: "context", title: "Gather branch and conflict context", status: "in_progress" },
			{ id: "merge", title: "Merge current main and resolve conflicts", status: "pending" },
			{ id: "verify", title: "Run affected checks", status: "pending" },
			{ id: "publish", title: "Push the resolved branch", status: "pending" },
		],
	} as const;

	test("accepts an arbitrary bounded plan and revises its active step", () => {
		const first = updateWorkPlan(null, initial, 1_000);
		const revised = updateWorkPlan(
			first,
			{
				...initial,
				steps: [
					{ ...initial.steps[0], status: "completed" },
					{ ...initial.steps[1], status: "in_progress" },
					initial.steps[2],
					initial.steps[3],
				],
			},
			2_000,
		);

		expect(revised.updatedAt).toBe(2_000);
		expect(revised.steps.map((step) => step.status)).toEqual([
			"completed",
			"in_progress",
			"pending",
			"pending",
		]);
	});

	test("does not let completed history disappear or regress", () => {
		const completed = updateWorkPlan(
			null,
			{
				summary: initial.summary,
				steps: [{ ...initial.steps[0], status: "completed" }],
			},
			1_000,
		);

		expect(() => updateWorkPlan(completed, { summary: initial.summary, steps: [] }, 2_000)).toThrow(
			/completed step context is missing/,
		);
		expect(() =>
			updateWorkPlan(completed, { summary: initial.summary, steps: [initial.steps[0]] }, 2_000),
		).toThrow(/completed step context cannot return/);
	});

	test("requires unique ids and at most one active step", () => {
		expect(() =>
			updateWorkPlan(
				null,
				{
					summary: "Inspect the change.",
					steps: [
						{ id: "inspect", title: "Inspect code", status: "in_progress" },
						{ id: "inspect", title: "Inspect tests", status: "in_progress" },
					],
				},
				1_000,
			),
		).toThrow(/unique/);
	});

	test("renders an evolving checklist and final outcome safely", () => {
		const plan = updateWorkPlan(
			null,
			{
				summary: "Resolve <unsafe> conflicts.",
				steps: [
					{
						id: "context",
						title: "Gather [context](bad) and ~~notes~~",
						status: "completed",
					},
					{ id: "merge", title: "Resolve conflicts", status: "in_progress" },
				],
			},
			1_000,
		);
		const working = renderWorkPlanComment({ plan, mode: "revise", status: "running" });
		expect(working).toContain("### Working on it");
		expect(working).toContain("- [x] Gather \\[context\\]\\(bad\\) and \\~\\~notes\\~\\~");
		expect(working).toContain("- [ ] **Resolve conflicts**");
		expect(working).not.toContain("<unsafe>");

		const finished = renderWorkPlanComment({
			plan,
			mode: "revise",
			status: "failed",
			outcome: "The merge still has unresolved conflicts.",
		});
		expect(finished).toContain("### Failed");
		expect(finished).toContain("The merge still has unresolved conflicts.");
		expect(
			renderWorkPlanComment({
				plan,
				mode: "repro",
				status: "needs_follow_up",
				outcome: "The bug reproduced, but no candidate was published.",
			}),
		).toContain("### Needs follow-up");
	});

	test("renders a safe deterministic workspace-preparation comment", () => {
		const comment = renderPreparingWorkPlanComment({
			mode: "implement",
			summary: "Implement <unsafe> adapter [support]",
		});

		expect(comment).toContain("### Preparing workspace");
		expect(comment).toContain("Implement &lt;unsafe&gt; adapter \\[support\\]");
		expect(comment).toContain("Installing dependencies and building the repository");
		expect(comment).toContain("_Mode: implement_");
		expect(comment).not.toContain("<unsafe>");
	});

	test("truncates an overlong directive instead of rejecting workspace preparation", () => {
		const summary = `Implement ${"adapter support ".repeat(30)}`;
		const plan = updateWorkPlan(
			null,
			{
				summary,
				steps: [{ id: "prepare", title: "Prepare workspace", status: "in_progress" }],
			},
			1_000,
		);
		const comment = renderPreparingWorkPlanComment({ mode: "implement", summary });

		expect(plan.summary.length).toBeLessThanOrEqual(240);
		expect(plan.summary).toMatch(/…$/);
		expect(comment).toContain(plan.summary);
	});
});
