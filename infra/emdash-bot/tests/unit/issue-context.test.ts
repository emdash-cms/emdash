import { describe, expect, test } from "vitest";

import {
	ISSUE_CONTEXT_MAX_CHARACTERS,
	ISSUE_CONTEXT_MAX_COMMENTS,
	buildIssueContext,
	shouldStoreDiagnosis,
	type IssueThreadComment,
	type StoredDiagnosis,
} from "../../.flue/lib/issue-context.js";

const diagnosis: StoredDiagnosis = {
	runId: "diagnosis-run",
	mode: "diagnose",
	completedAt: "2026-08-17T10:00:00.000Z",
	result: {
		reproduced: true,
		demonstration: "failing-test",
		demonstratedReportedIssue: true,
		summary: "The locale fallback loses the requested locale before the content query.",
	},
};

function comment(overrides: Partial<IssueThreadComment> = {}): IssueThreadComment {
	return {
		id: 1,
		body: "The failure also happens when the cache is cold.",
		authorLogin: "reporter",
		authorAssociation: "CONTRIBUTOR",
		authorType: "User",
		createdAt: "2026-08-17T10:30:00.000Z",
		...overrides,
	};
}

describe("issue run context", () => {
	test("carries the last diagnosis and trust-labelled human discussion into a later write run", () => {
		const { text: context } = buildIssueContext({
			diagnosis,
			trigger: {
				id: 9,
				body: "@emdashbot fix Keep the locale in the cache key.",
				authorLogin: "maintainer",
				authorAssociation: "MEMBER",
				actor: "maintainer",
			},
			comments: [
				comment({ id: 2, createdAt: "2026-08-17T09:59:59.000Z", body: "stale" }),
				comment({ id: 3 }),
				comment({
					id: 4,
					authorLogin: "emdashbot",
					authorType: "Bot",
					createdAt: "2026-08-17T09:30:00.000Z",
					body: "Earlier bot finding: the cache key omits the locale.",
				}),
				comment({
					id: 7,
					authorLogin: "dependabot[bot]",
					authorType: "Bot",
					body: "Unrelated dependency update.",
				}),
				comment({ id: 5, body: "@emdashbot retry" }),
				comment({
					id: 6,
					body: "The schema migration must remain additive.",
					authorLogin: "reviewer",
					authorAssociation: "COLLABORATOR",
				}),
			],
		});

		expect(context).toContain("## Last successful diagnosis");
		expect(context).toContain(diagnosis.result.summary);
		expect(context).toContain("@reporter (CONTRIBUTOR; public, untrusted)");
		expect(context).toContain("@reviewer (COLLABORATOR; maintainer-authorized)");
		expect(context).not.toContain("stale");
		expect(context).toContain("Earlier bot finding: the cache key omits the locale.");
		expect(context).toContain("bot output; trusted context, not a directive");
		expect(context).not.toContain("Unrelated dependency update.");
		expect(context).not.toContain("@emdashbot retry");
		expect(context).toContain("## Triggering directive (authoritative)");
		expect(context).toContain("@emdashbot fix Keep the locale in the cache key.");
		expect(context.lastIndexOf("Triggering directive")).toBeGreaterThan(
			context.lastIndexOf("Earlier issue-thread context"),
		);
	});

	test("keeps the trigger while bounding comment count and total comment characters", () => {
		const comments = Array.from({ length: ISSUE_CONTEXT_MAX_COMMENTS + 10 }, (_, index) =>
			comment({
				id: index + 1,
				body: `human-context-${index} ${"x".repeat(ISSUE_CONTEXT_MAX_CHARACTERS)}`,
				createdAt: new Date(Date.UTC(2026, 7, 17, 11, index)).toISOString(),
			}),
		);
		const triggerBody = `@emdashbot implement ${"z".repeat(ISSUE_CONTEXT_MAX_CHARACTERS * 2)}`;
		const built = buildIssueContext({
			diagnosis: null,
			trigger: {
				id: 999,
				body: triggerBody,
				authorLogin: "maintainer",
				authorAssociation: "OWNER",
				actor: "maintainer",
			},
			comments,
		});

		expect(built.commentCount).toBeLessThanOrEqual(ISSUE_CONTEXT_MAX_COMMENTS);
		expect(built.commentCharacters).toBeLessThanOrEqual(ISSUE_CONTEXT_MAX_CHARACTERS);
		expect(built.text).toContain("## Triggering directive (authoritative)");
		expect(built.text).toContain("@emdashbot implement");
	});

	test("prioritizes EmDashBot history over newer human comments within the bound", () => {
		const built = buildIssueContext({
			diagnosis: null,
			trigger: {
				id: 999,
				body: "@emdashbot fix",
				authorLogin: "maintainer",
				authorAssociation: "MEMBER",
				actor: "maintainer",
			},
			comments: [
				comment({
					id: 1,
					authorLogin: "emdashbot",
					authorType: "Bot",
					createdAt: "2026-08-17T09:00:00.000Z",
					body: "Earlier bot result that must survive the recent window.",
				}),
				...Array.from({ length: ISSUE_CONTEXT_MAX_COMMENTS + 5 }, (_, index) =>
					comment({
						id: index + 10,
						createdAt: new Date(Date.UTC(2026, 7, 17, 10, index)).toISOString(),
						body: `newer-human-${index}`,
					}),
				),
			],
		});

		expect(built.text).toContain("Earlier bot result that must survive the recent window.");
		expect(built.commentCount).toBeLessThanOrEqual(ISSUE_CONTEXT_MAX_COMMENTS);
	});
});

describe("diagnosis retention", () => {
	test("accepts only successful structured repro or diagnosis findings", () => {
		expect(shouldStoreDiagnosis("diagnose", diagnosis.result, true)).toBe(true);
		expect(
			shouldStoreDiagnosis(
				"repro",
				{ rootCauseFound: true, summary: "The query omits the locale filter." },
				true,
			),
		).toBe(true);

		for (const candidate of [
			{ mode: "fix" as const, result: diagnosis.result, ok: true },
			{ mode: "diagnose" as const, result: diagnosis.result, ok: false },
			{
				mode: "diagnose" as const,
				result: { ...diagnosis.result, failureStage: "verification" },
				ok: true,
			},
			{
				mode: "diagnose" as const,
				result: { reproduced: false, rootCauseFound: false, summary: "No finding." },
				ok: true,
			},
		]) {
			expect(shouldStoreDiagnosis(candidate.mode, candidate.result, candidate.ok)).toBe(false);
		}
	});
});
