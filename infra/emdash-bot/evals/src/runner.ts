// Eval run orchestration. Operator-only: it fetches issue bodies from GitHub,
// dispatches investigations to the deployed worker, waits for verdicts, and
// scores them. Pure scoring/formatting live in their own modules and are the
// only parts CI exercises.

import { dispatchInvestigation, waitForResult, type AgentEndpoint } from "./client.ts";
import { checkoutRefFor, filterByCategory, findCase } from "./dataset.ts";
import { scoreCase } from "./scorer.ts";
import type { Category, Dataset, EvalCase, ScoredResult } from "./types.ts";

export interface RunConfig extends AgentEndpoint {
	/** GitHub token used to read issue titles/bodies (read-only). */
	readonly githubToken: string;
	readonly owner: string;
	readonly repo: string;
	/** Per-case verdict timeout. Defaults to 30 min (the agent's durability ceiling). */
	readonly timeoutMs?: number;
	readonly pollMs?: number;
	/** Console sink; defaults to console.log. Injectable for tests. */
	readonly log?: (message: string) => void;
}

export type Selection =
	| { readonly kind: "all" }
	| { readonly kind: "category"; readonly category: Category }
	| { readonly kind: "cases"; readonly numbers: readonly number[] };

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;

export function selectCases(dataset: Dataset, selection: Selection): EvalCase[] {
	switch (selection.kind) {
		case "all":
			return [...dataset.cases];
		case "category":
			return filterByCategory(dataset, selection.category);
		case "cases": {
			const cases: EvalCase[] = [];
			for (const n of selection.numbers) {
				const c = findCase(dataset, n);
				if (!c) throw new Error(`no case #${n} in the dataset`);
				cases.push(c);
			}
			return cases;
		}
	}
}

interface Issue {
	readonly title: string;
	readonly body: string;
}

async function fetchIssue(config: RunConfig, number: number): Promise<Issue> {
	const response = await fetch(
		`https://api.github.com/repos/${config.owner}/${config.repo}/issues/${number}`,
		{
			headers: {
				authorization: `Bearer ${config.githubToken}`,
				accept: "application/vnd.github+json",
				"user-agent": "emdash-bot-evals",
			},
		},
	);
	if (!response.ok) {
		throw new Error(`fetch issue #${number} failed: ${response.status}`);
	}
	const issue = await response.json<{ title?: string; body?: string | null }>();
	return { title: issue.title ?? `Issue #${number}`, body: issue.body ?? "" };
}

async function runOne(config: RunConfig, evalCase: EvalCase): Promise<ScoredResult> {
	const log = config.log ?? console.log;
	const baseRef = checkoutRefFor(evalCase);
	log(`#${evalCase.number} [${evalCase.category}] dispatching @ ${baseRef.slice(0, 12)}`);
	try {
		const issue = await fetchIssue(config, evalCase.number);
		const runId = crypto.randomUUID();
		const agentId = `eval-${evalCase.number}-${runId}`;
		await dispatchInvestigation({ baseUrl: config.baseUrl, token: config.token }, agentId, {
			runId,
			issueNumber: evalCase.number,
			mode: "diagnose",
			arg: null,
			issueTitle: issue.title,
			issueBody: issue.body,
			previousBranchSha: null,
			baseRef,
		});
		const reported = await waitForResult(
			{ baseUrl: config.baseUrl, token: config.token },
			agentId,
			{
				timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				pollMs: config.pollMs ?? DEFAULT_POLL_MS,
			},
		);
		if (!reported) {
			return scoreCase(evalCase, { error: "run settled without a reported verdict" });
		}
		const scored = scoreCase(evalCase, reported);
		log(`#${evalCase.number} -> ${scored.outcome} (${scored.grade})`);
		return scored;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`#${evalCase.number} -> ERROR: ${message}`);
		return scoreCase(evalCase, { error: message });
	}
}

/** Run the selected cases sequentially, returning one scored result each. */
export async function runEvals(
	config: RunConfig,
	dataset: Dataset,
	selection: Selection,
): Promise<ScoredResult[]> {
	const cases = selectCases(dataset, selection);
	const results: ScoredResult[] = [];
	for (const evalCase of cases) {
		results.push(await runOne(config, evalCase));
	}
	return results;
}
