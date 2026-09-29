import { DurableObject } from "cloudflare:workers";

import { loadDashboardPayload, type DashboardIssueUpdate } from "./dashboard.js";
import { githubRateLimitGate } from "./github-rate-limit-client.js";
import {
	listOpenManagedIssues,
	readRepoContext,
	GitHubRateLimitError,
	type ManagedIssueSummary,
} from "./github.js";

const ISSUES_KEY = "dashboard:issues";
const INITIALIZED_KEY = "dashboard:initialized";
const DASHBOARD_ISSUE_LIMIT = 100;
const BOOTSTRAP_RETRY_MS = 60_000;
const DASHBOARD_RECONCILE_MS = 5 * 60_000;

export class DashboardDO extends DurableObject<Env> {
	async getPayload() {
		const [issues, initialized, alarm] = await Promise.all([
			this.ctx.storage.get<ManagedIssueSummary[]>(ISSUES_KEY),
			this.ctx.storage.get<boolean>(INITIALIZED_KEY),
			this.ctx.storage.getAlarm(),
		]);
		if (!initialized && alarm === null && this.env.GITHUB_APP_PRIVATE_KEY) {
			await this.ctx.storage.setAlarm(Date.now());
		}
		return loadDashboardPayload(this.env, issues ?? []);
	}

	async recordIssue(update: DashboardIssueUpdate): Promise<void> {
		const issues = (await this.ctx.storage.get<ManagedIssueSummary[]>(ISSUES_KEY)) ?? [];
		const issueNumber = update.kind === "upsert" ? update.issue.number : update.number;
		const withoutIssue = issues.filter((issue) => issue.number !== issueNumber);
		if (update.kind === "remove") {
			await this.ctx.storage.put(ISSUES_KEY, withoutIssue);
			return;
		}
		await this.ctx.storage.put(
			ISSUES_KEY,
			[update.issue, ...withoutIssue]
				.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
				.slice(0, DASHBOARD_ISSUE_LIMIT),
		);
	}

	override async alarm(): Promise<void> {
		try {
			const repo = readRepoContext(this.env);
			if (!repo) throw new Error("GitHub repository context missing");
			const gate = githubRateLimitGate(this.env);
			const consumer = "dashboard-bootstrap";
			const token = await gate.getInstallationToken();
			const issues = await listOpenManagedIssues({ token, gate, consumer }, repo);
			await this.ctx.storage.transaction(async (transaction) => {
				await transaction.put({
					[ISSUES_KEY]: issues.slice(0, DASHBOARD_ISSUE_LIMIT),
					[INITIALIZED_KEY]: true,
				});
				await transaction.setAlarm(Date.now() + DASHBOARD_RECONCILE_MS);
			});
		} catch (error) {
			const retryAt =
				error instanceof GitHubRateLimitError ? error.retryAt : Date.now() + BOOTSTRAP_RETRY_MS;
			console.error("[dashboard] bootstrap failed", {
				error: error instanceof Error ? error.message : String(error),
				retryAt,
			});
			await this.ctx.storage.setAlarm(retryAt);
		}
	}
}
