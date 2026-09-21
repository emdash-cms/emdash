import { githubRateLimitGate } from "./github-rate-limit-client.js";
import {
	listOpenManagedIssues,
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
	GitHubRateLimitError,
	type ManagedIssueSummary,
} from "./github.js";
import { KINDS, machineSnapshot, type Kind, type StateId } from "./machine.js";
import type { PublicIssueSnapshot } from "./orchestrator.js";
import { currentState } from "./router.js";
import { runMachineSnapshot } from "./run-lifecycle.js";

const DASHBOARD_CACHE_MS = 20_000;
const DASHBOARD_ISSUE_LIMIT = 100;
const DASHBOARD_BACKOFF_BASE_MS = 30_000;
const DASHBOARD_BACKOFF_MAX_MS = 5 * 60_000;

interface DashboardCache {
	expiresAt: number;
	retryAt: number;
	failures: number;
	value: DashboardPayload | null;
	pending: Promise<DashboardPayload> | null;
}

declare global {
	var emdashBotDashboardCache: DashboardCache | undefined;
}

export interface DashboardIssue extends ManagedIssueSummary, PublicIssueSnapshot {
	state: StateId;
	kind: Kind;
}

export interface DashboardPayload {
	updatedAt: string;
	repositoryUrl: string;
	machines: {
		issue: ReturnType<typeof machineSnapshot>;
		run: ReturnType<typeof runMachineSnapshot>;
	};
	issues: DashboardIssue[];
}

export class DashboardUnavailableError extends Error {
	constructor(
		readonly retryAt: number,
		cause: unknown,
	) {
		super(cause instanceof Error ? cause.message : "Dashboard data is temporarily unavailable", {
			cause,
		});
		this.name = "DashboardUnavailableError";
	}
}

export async function getDashboardPayload(env: Env): Promise<DashboardPayload> {
	const now = Date.now();
	const cached = globalThis.emdashBotDashboardCache;
	if (cached?.value && cached.expiresAt > now) return cached.value;
	if (cached && cached.retryAt > now) {
		if (cached.value) return cached.value;
		throw new DashboardUnavailableError(cached.retryAt, "Dashboard refresh is backed off");
	}
	if (cached?.pending) return cached.pending;

	let pending: Promise<DashboardPayload>;
	pending = loadDashboardPayload(env)
		.then((value) => {
			if (globalThis.emdashBotDashboardCache?.pending === pending) {
				globalThis.emdashBotDashboardCache = {
					expiresAt: Date.now() + DASHBOARD_CACHE_MS,
					retryAt: 0,
					failures: 0,
					value,
					pending: null,
				};
			}
			return value;
		})
		.catch((error: unknown) => {
			const current = globalThis.emdashBotDashboardCache;
			const failures = (current?.failures ?? 0) + 1;
			const exponentialRetryAt =
				Date.now() +
				Math.min(
					DASHBOARD_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
					DASHBOARD_BACKOFF_MAX_MS,
				);
			const retryAt = Math.max(
				exponentialRetryAt,
				error instanceof GitHubRateLimitError ? error.retryAt : 0,
			);
			const stale = current?.value ?? null;
			if (current?.pending === pending) {
				globalThis.emdashBotDashboardCache = {
					expiresAt: current.expiresAt,
					retryAt,
					failures,
					value: stale,
					pending: null,
				};
			}
			if (stale) return stale;
			throw new DashboardUnavailableError(retryAt, error);
		});
	globalThis.emdashBotDashboardCache = {
		expiresAt: cached?.expiresAt ?? 0,
		retryAt: cached?.retryAt ?? 0,
		failures: cached?.failures ?? 0,
		value: cached?.value ?? null,
		pending,
	};
	return pending;
}

export async function loadDashboardPayload(env: Env): Promise<DashboardPayload> {
	const creds = readAppCreds(env);
	const repo = readRepoContext(env);
	if (!creds || !repo) throw new Error("GitHub credentials or repository context missing");
	const gate = githubRateLimitGate(env);
	const consumer = "dashboard";
	const tokenValue = await mintInstallationToken(creds, undefined, { token: "", gate, consumer });
	const token = { token: tokenValue, gate, consumer };
	const githubIssues = (await listOpenManagedIssues(token, repo)).slice(0, DASHBOARD_ISSUE_LIMIT);
	const snapshots = await Promise.allSettled(
		githubIssues.map((issue) =>
			env.Orchestrator.getByName(`issue-${issue.number}`).getPublicSnapshot(),
		),
	);
	const issues = githubIssues.flatMap((issue, index) => {
		const settled = snapshots[index];
		if (!settled) return [];
		if (settled.status === "rejected") {
			console.warn("[dashboard] issue snapshot unavailable", {
				issueNumber: issue.number,
				error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
			});
		}
		const snapshot =
			settled.status === "fulfilled"
				? settled.value
				: ({
						state: null,
						kind: null,
						run: null,
						workPlan: null,
						currentRunStartedAt: null,
						prNumber: null,
						pullRequest: null,
						transitions: [],
						progress: [],
					} satisfies PublicIssueSnapshot);
		const state = snapshot.state ?? stateFromLabels(issue.labels);
		const kind = snapshot.kind ?? kindFromLabels(issue.labels);
		if (!state || !kind) return [];
		return [{ ...issue, ...snapshot, state, kind } satisfies DashboardIssue];
	});
	return {
		updatedAt: new Date().toISOString(),
		repositoryUrl: `https://github.com/${repo.owner}/${repo.repo}`,
		machines: { issue: machineSnapshot(), run: runMachineSnapshot() },
		issues,
	};
}

function stateFromLabels(labels: readonly string[]): StateId | null {
	return currentState(labels);
}

function kindFromLabels(labels: readonly string[]): Kind | null {
	for (const kind of KINDS) if (labels.includes(`bot:${kind}`)) return kind;
	return null;
}
