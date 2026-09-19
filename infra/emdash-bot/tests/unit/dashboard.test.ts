import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const github = vi.hoisted(() => ({
	GitHubRateLimitError: class extends Error {},
	listOpenManagedIssues: vi.fn(),
	mintInstallationToken: vi.fn(),
	readAppCreds: vi.fn(),
	readRepoContext: vi.fn(),
}));

vi.mock("../../.flue/lib/github.js", () => github);

import { getDashboardPayload, loadDashboardPayload } from "../../.flue/lib/dashboard.js";
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
		github.readAppCreds.mockReturnValue({
			appId: "app",
			installationId: "installation",
			privateKeyPem: "key",
		});
		github.readRepoContext.mockReturnValue(repo);
		github.mintInstallationToken.mockResolvedValue("token");
		github.listOpenManagedIssues.mockReset();
		delete globalThis.emdashBotDashboardCache;
	});

	afterEach(() => {
		vi.useRealTimers();
		delete globalThis.emdashBotDashboardCache;
	});

	test("keeps issues whose Durable Object snapshot cannot be read", async () => {
		github.listOpenManagedIssues.mockResolvedValue([managedIssue(1), managedIssue(2)]);
		const env = dashboardEnv((issueNumber) =>
			issueNumber === 1
				? Promise.resolve({ ...emptySnapshot, state: "working", kind: "bug" })
				: Promise.reject(new Error("snapshot unavailable")),
		);

		const payload = await loadDashboardPayload(env);

		expect(payload.issues).toHaveLength(2);
		expect(payload.issues[1]).toMatchObject({
			number: 2,
			state: "working",
			kind: "bug",
			run: null,
		});
	});

	test("serves the last successful payload and backs off after a refresh failure", async () => {
		const now = Date.parse("2026-09-16T10:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		github.listOpenManagedIssues
			.mockResolvedValueOnce([managedIssue(1)])
			.mockRejectedValueOnce(new Error("GitHub unavailable"))
			.mockResolvedValueOnce([managedIssue(2)]);
		const env = dashboardEnv(() => Promise.resolve(emptySnapshot));

		const fresh = await getDashboardPayload(env);
		vi.setSystemTime(now + 21_000);
		const stale = await getDashboardPayload(env);
		const backedOff = await getDashboardPayload(env);

		expect(stale).toBe(fresh);
		expect(backedOff).toBe(fresh);
		expect(github.listOpenManagedIssues).toHaveBeenCalledTimes(2);
	});

	test("shares stale fallback across concurrent refresh requests", async () => {
		const now = Date.parse("2026-09-16T10:00:00Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		let rejectRefresh: (error: Error) => void = () => {};
		const refresh = new Promise<never>((_, reject) => {
			rejectRefresh = reject;
		});
		github.listOpenManagedIssues
			.mockResolvedValueOnce([managedIssue(1)])
			.mockReturnValueOnce(refresh);
		const env = dashboardEnv(() => Promise.resolve(emptySnapshot));
		const fresh = await getDashboardPayload(env);
		vi.setSystemTime(now + 21_000);

		const first = getDashboardPayload(env);
		const second = getDashboardPayload(env);
		rejectRefresh(new Error("GitHub unavailable"));

		await expect(first).resolves.toBe(fresh);
		await expect(second).resolves.toBe(fresh);
		expect(github.listOpenManagedIssues).toHaveBeenCalledTimes(2);
	});
});
