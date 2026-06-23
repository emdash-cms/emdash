// Review workflow (Cloudflare target) -- cf-shell (Cloudflare Shell) variant.
//
// Reviews one pull request and returns structured findings plus a verdict. No
// firecracker container: the PR is hydrated into a durable cf-shell Workspace
// (DO SQLite + R2 for large files) via JS git, and the agent inspects it with a
// Worker-Loader-backed `code` tool. It does NOT post to GitHub: the orchestrator
// (the workflow's trusted DO code) posts with a write-scoped installation token,
// so no secret is ever reachable by the model.

import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";

import { getDefaultWorkspace, getShellSandbox } from "../sandboxes/cloudflare-shell.js";
import { withCapacityRetry } from "../lib/capacity.js";
import {
	readAppCreds,
	mintInstallationToken,
	fetchUnifiedDiff,
	fetchPriorReview,
	postReview,
	addEyesReaction,
	removeReaction,
} from "../lib/github.js";
import { reviewResultSchema, type ReviewResult } from "../lib/review-schema.js";
import review from "../skills/review/SKILL.md" with { type: "skill" };

interface ReviewPayload {
	prNumber: number;
	prTitle: string;
	prBody: string;
	headRef: string;
	baseRef: string;
	owner: string;
	repo: string;
}

const REPO_DIR = "/repo";
const DIFF_PATH = `${REPO_DIR}/.flue-pr.diff`;
const HYDRATED = `${REPO_DIR}/.flue-hydrated`;

const NAME = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;

function assertSafe(payload: ReviewPayload): void {
	if (!Number.isInteger(payload.prNumber) || payload.prNumber <= 0) {
		throw new Error("payload.prNumber must be a positive integer");
	}
	if (!payload.prTitle) throw new Error("payload.prTitle is required");
	for (const [key, value] of [
		["owner", payload.owner],
		["repo", payload.repo],
	] as const) {
		if (!value || !NAME.test(value)) throw new Error(`payload.${key} missing or unsafe`);
	}
	for (const [key, value] of [
		["baseRef", payload.baseRef],
		["headRef", payload.headRef],
	] as const) {
		if (!value || !REF.test(value) || value.includes("..")) {
			throw new Error(`payload.${key} missing or not a safe git ref`);
		}
	}
}

// cf-shell agent: hydrate the PR into the durable Workspace via JS git (shallow
// clone of base, then fetch + checkout the PR head -- refs/pull/N/head covers
// fork PRs), then expose the Workspace through the Worker-Loader `code` tool.
// Large objects (the git packfile) spill to R2 (see the workspace `name`).
const reviewAgent = createAgent<ReviewPayload, Env>(async ({ id, env, payload }) => {
	const workspace = getDefaultWorkspace(env.REVIEW_WORKSPACE, `review-${id}`);
	const fs = new WorkspaceFileSystem(workspace);

	if (payload && !(await workspace.exists(HYDRATED))) {
		const cloneUrl = `https://github.com/${payload.owner}/${payload.repo}.git`;
		const git = createGit(fs);
		await git.clone({
			url: cloneUrl,
			dir: REPO_DIR,
			branch: payload.baseRef,
			singleBranch: true,
			depth: 1,
		});
		const fetched = await git.fetch({ ref: `pull/${payload.prNumber}/head`, depth: 1, dir: REPO_DIR });
		if (fetched.fetchHead) {
			await git.checkout({ ref: fetched.fetchHead, dir: REPO_DIR, force: true });
		}
		await workspace.writeFile(HYDRATED, new Date().toISOString());
	}

	return {
		// Kimi (k2.7-code) via the Workers AI binding: no model API key needed.
		model: "cloudflare/@cf/moonshotai/kimi-k2.7-code",
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		cwd: REPO_DIR,
		instructions: [
			"You are EmDash's automated pull request reviewer.",
			"You investigate one PR in depth and return structured, line-anchored findings plus an overall verdict.",
			"You inspect the checked-out repo with the `code` tool (JavaScript over `state.*`); there is no shell.",
			"You are read-only: no posting. The orchestrator posts your review after you finish.",
			"Follow the review skill's protocol exactly and return strictly schema-conformant output.",
		].join(" "),
		skills: [review],
	};
});

export const route: WorkflowRouteHandler = async (_c, next) => next();

function buildPrContext(payload: ReviewPayload, priorReview?: string): string {
	const lines = [
		`PR #${payload.prNumber} in ${payload.owner}/${payload.repo}.`,
		`Head ref: ${payload.headRef}. Base branch: ${payload.baseRef}.`,
		`The repo is checked out at the PR head under ${REPO_DIR}. The unified diff is at ${DIFF_PATH}.`,
		`Title: ${payload.prTitle}`,
		"",
		"## Description",
		"",
		payload.prBody || "(no description provided)",
	];
	if (priorReview) {
		lines.push("", "## Prior review context (this is a re-review)", "", priorReview);
	}
	return lines.join("\n");
}

export async function run(ctx: FlueContext<ReviewPayload, Env>): Promise<ReviewResult> {
	const { init, payload, env } = ctx;
	assertSafe(payload);

	// GitHub access lives only in this trusted DO code, never in the agent's
	// workspace. Without app creds (local dev) we skip posting and return.
	const creds = readAppCreds(env);
	let token: string | undefined;
	let priorReview: string | undefined;
	let reactionId: number | undefined;
	if (creds) {
		token = await mintInstallationToken(creds);
		reactionId = await addEyesReaction(token, payload.owner, payload.repo, payload.prNumber);
		priorReview = await fetchPriorReview(token, payload.owner, payload.repo, payload.prNumber);
	}

	try {
		// init() hydrates the Workspace (clone + checkout the PR head).
		const harness = await init(reviewAgent);
		const session = await harness.session();

		// Stage the canonical unified diff into the Workspace (no `git` in cf-shell).
		const diff = await fetchUnifiedDiff(payload.owner, payload.repo, payload.prNumber, token);
		await harness.fs.writeFile(DIFF_PATH, diff);

		const { data } = await withCapacityRetry(
			(signal) =>
				session.skill("review", {
					args: {
						prContext: buildPrContext(payload, priorReview),
						owner: payload.owner,
						repo: payload.repo,
						prNumber: payload.prNumber,
						baseRef: payload.baseRef,
						headRef: payload.headRef,
						repoDir: REPO_DIR,
						diffPath: DIFF_PATH,
					},
					result: reviewResultSchema,
					signal,
				}),
			{
				label: `review#${payload.prNumber}`,
				attempts: 3,
				perAttemptTimeoutMs: 20 * 60_000,
				onRetry: ({ attempt, delayMs, error }) =>
					ctx.log.warn?.("[review] model over capacity, backing off", {
						prNumber: payload.prNumber,
						attempt,
						delayMs,
						error: String(error),
					}),
			},
		);

		console.log("[review] result", {
			prNumber: payload.prNumber,
			hasToken: Boolean(token),
			verdict: data.verdict,
			summaryLen: data.summary.length,
			findings: data.findings.length,
		});

		if (token) {
			try {
				await postReview(token, payload.owner, payload.repo, payload.prNumber, data);
			} catch (err) {
				console.error("[review] postReview failed", {
					error: err instanceof Error ? err.message : String(err),
					prNumber: payload.prNumber,
				});
			}
		} else {
			console.log("[review] no GitHub App creds; skipping post", { prNumber: payload.prNumber });
		}

		return data;
	} finally {
		if (token && reactionId !== undefined) {
			await removeReaction(token, payload.owner, payload.repo, payload.prNumber, reactionId);
		}
	}
}
