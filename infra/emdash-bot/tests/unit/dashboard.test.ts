import { beforeEach, describe, expect, test, vi } from "vitest";

const github = vi.hoisted(() => ({
	GitHubRateLimitError: class extends Error {},
	listOpenManagedIssues: vi.fn(),
	readRepoContext: vi.fn(),
}));

vi.mock("../../.flue/lib/github.js", () => github);

import {
	dashboardIssueUpdate,
	getDashboardPayload,
	loadDashboardPayload,
} from "../../.flue/lib/dashboard.js";
import type { PublicIssueSnapshot } from "../../.flue/lib/orchestrator.js";

const repo = { owner: "emdash-cms", repo: "emdash" };
const emptySnapshot: PublicIssueSnapshot = {
	state: null,
	kind: null,
	run: null,
	workPlan: null,
	currentRunStartedAt: null,
	prNumber: null,
	pullRequest: null,
	transitions: [],
	progress: [],
};

function managedIssue(number: number) {
	return {
		number,
		title: `Issue ${number}`,
		url: `https://github.com/emdash-cms/emdash/issues/${number}`,
		updatedAt: "2026-09-16T10:00:00Z",
		labels: ["bot:bug", "bot:working"],
	};
}

function dashboardEnv(getPublicSnapshot: (issueNumber: number) => Promise<PublicIssueSnapshot>) {
	return {
		Orchestrator: {
			getByName(name: string) {
				const issueNumber = Number(name.slice("issue-".length));
				return { getPublicSnapshot: () => getPublicSnapshot(issueNumber) };
			},
		},
	} as unknown as Env;
}

describe("dashboard loading", () => {
	beforeEach(() => {
		github.readRepoContext.mockReturnValue(repo);
		github.listOpenManagedIssues.mockReset();
	});

	test("keeps issues whose Durable Object snapshot cannot be read", async () => {
		const env = dashboardEnv((issueNumber) =>
			issueNumber === 1
				? Promise.resolve({ ...emptySnapshot, state: "working", kind: "bug" })
				: Promise.reject(new Error("snapshot unavailable")),
		);

		const payload = await loadDashboardPayload(env, [managedIssue(1), managedIssue(2)]);

		expect(payload.issues).toHaveLength(2);
		expect(payload.issues[1]).toMatchObject({
			number: 2,
			state: "working",
			kind: "bug",
			run: null,
		});
		expect(github.listOpenManagedIssues).not.toHaveBeenCalled();
	});

	test("serves the dashboard from its repository Durable Object", async () => {
		const payload = { issues: [] };
		const getPayload = vi.fn(async () => payload);
		const env = {
			DASHBOARD: { getByName: vi.fn(() => ({ getPayload })) },
		} as unknown as Env;

		await expect(getDashboardPayload(env)).resolves.toBe(payload);
		expect(getPayload).toHaveBeenCalledOnce();
		expect(github.listOpenManagedIssues).not.toHaveBeenCalled();
	});
});

describe("dashboard webhook index", () => {
	test("extracts an open managed issue", () => {
		expect(
			dashboardIssueUpdate({
				issue: {
					number: 3056,
					title: "Rate limit exhaustion",
					html_url: "https://github.com/emdash-cms/emdash/issues/3056",
					updated_at: "2026-09-21T08:00:00Z",
					state: "open",
					labels: [{ name: "bot:bug" }, { name: "bot:working" }],
				},
			}),
		).toEqual({
			kind: "upsert",
			issue: {
				number: 3056,
				title: "Rate limit exhaustion",
				url: "https://github.com/emdash-cms/emdash/issues/3056",
				updatedAt: "2026-09-21T08:00:00Z",
				labels: ["bot:bug", "bot:working"],
			},
		});
	});

	test("removes closed and unmanaged issues", () => {
		expect(dashboardIssueUpdate({ issue: { number: 42, state: "closed" } })).toEqual({
			kind: "remove",
			number: 42,
		});
		expect(dashboardIssueUpdate({ issue: { number: 43, state: "open", labels: [] } })).toEqual({
			kind: "remove",
			number: 43,
		});
	});

	test("ignores pull request payload issue objects", () => {
		expect(
			dashboardIssueUpdate({ issue: { number: 44, state: "open", pull_request: {} } }),
		).toBeNull();
	});
});
