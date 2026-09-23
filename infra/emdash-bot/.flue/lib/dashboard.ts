import { readRepoContext, type ManagedIssueSummary } from "./github.js";
import { KINDS, machineSnapshot, type Kind, type StateId } from "./machine.js";
import type { PublicIssueSnapshot } from "./orchestrator.js";
import { currentState } from "./router.js";
import { runMachineSnapshot } from "./run-lifecycle.js";

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

export type DashboardIssueUpdate =
	| { readonly kind: "upsert"; readonly issue: ManagedIssueSummary }
	| { readonly kind: "remove"; readonly number: number };

export async function getDashboardPayload(env: Env): Promise<DashboardPayload> {
	const repo = readRepoContext(env);
	if (!repo) throw new Error("GitHub repository context missing");
	const payload = await env.DASHBOARD.getByName(`repo:${repo.owner}/${repo.repo}`).getPayload();
	return payload;
}

export async function loadDashboardPayload(
	env: Env,
	githubIssues: readonly ManagedIssueSummary[],
): Promise<DashboardPayload> {
	const repo = readRepoContext(env);
	if (!repo) throw new Error("GitHub repository context missing");
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
		const snapshot = settled.status === "fulfilled" ? settled.value : emptyPublicIssueSnapshot();
		const state = snapshot.state ?? currentState(issue.labels);
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

export function dashboardIssueUpdate(payload: unknown): DashboardIssueUpdate | null {
	if (!isRecord(payload)) return null;
	const record = payload.issue;
	if (!isRecord(record) || "pull_request" in record) return null;
	const number = record.number;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
	if (record.state !== "open") return { kind: "remove", number };
	const labels = Array.isArray(record.labels)
		? record.labels.flatMap((label) => {
				if (typeof label === "string") return [label];
				if (!isRecord(label)) return [];
				const name = label.name;
				return typeof name === "string" ? [name] : [];
			})
		: [];
	if (!KINDS.some((kind) => labels.includes(`bot:${kind}`))) return { kind: "remove", number };
	if (
		typeof record.title !== "string" ||
		typeof record.html_url !== "string" ||
		typeof record.updated_at !== "string"
	) {
		return null;
	}
	return {
		kind: "upsert",
		issue: {
			number,
			title: record.title,
			url: record.html_url,
			updatedAt: record.updated_at,
			labels,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function kindFromLabels(labels: readonly string[]): Kind | null {
	for (const kind of KINDS) if (labels.includes(`bot:${kind}`)) return kind;
	return null;
}

function emptyPublicIssueSnapshot(): PublicIssueSnapshot {
	return {
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
}
