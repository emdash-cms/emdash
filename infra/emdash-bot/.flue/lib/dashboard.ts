import {
	listOpenManagedIssues,
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
	type ManagedIssueSummary,
} from "./github.js";
import { KINDS, machineSnapshot, type Kind, type StateId } from "./machine.js";
import type { OrchestratorDO, PublicIssueSnapshot } from "./orchestrator.js";
import { currentState } from "./router.js";
import { runMachineSnapshot } from "./run-lifecycle.js";

const DASHBOARD_CACHE_MS = 20_000;
const DASHBOARD_ISSUE_LIMIT = 100;

interface DashboardCache {
	expiresAt: number;
	value: Promise<DashboardPayload>;
}

declare global {
	var emdashBotDashboardCache: DashboardCache | undefined;
}

interface DashboardEnv extends Env {
	Orchestrator: DurableObjectNamespace<OrchestratorDO>;
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

export function getDashboardPayload(env: Env): Promise<DashboardPayload> {
	const cached = globalThis.emdashBotDashboardCache;
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	const value = loadDashboardPayload(env).catch((error) => {
		if (globalThis.emdashBotDashboardCache?.value === value) {
			globalThis.emdashBotDashboardCache = undefined;
		}
		throw error;
	});
	globalThis.emdashBotDashboardCache = { expiresAt: Date.now() + DASHBOARD_CACHE_MS, value };
	return value;
}

export async function loadDashboardPayload(env: Env): Promise<DashboardPayload> {
	const creds = readAppCreds(env);
	const repo = readRepoContext(env);
	if (!creds || !repo) throw new Error("GitHub credentials or repository context missing");
	const token = await mintInstallationToken(creds);
	const githubIssues = (await listOpenManagedIssues(token, repo)).slice(0, DASHBOARD_ISSUE_LIMIT);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler cannot infer local DO RPC methods.
	const dashboardEnv = env as DashboardEnv;
	const snapshots = await Promise.all(
		githubIssues.map((issue) =>
			dashboardEnv.Orchestrator.getByName(`issue-${issue.number}`).getPublicSnapshot(),
		),
	);
	const issues = githubIssues.flatMap((issue, index) => {
		const snapshot = snapshots[index];
		if (!snapshot) return [];
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
