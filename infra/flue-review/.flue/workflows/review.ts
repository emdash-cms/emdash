// Review workflow (Cloudflare target) -- cf-shell (Cloudflare Shell) variant.
//
// Reviews one pull request and returns structured findings plus a verdict. No
// firecracker container: the PR is hydrated into a durable cf-shell Workspace
// (DO SQLite + R2 for large files) via JS git, and the agent inspects it with a
// Worker-Loader-backed `code` tool. It does NOT post to GitHub: the workflow's
// trusted Action code posts with a write-scoped installation token, so no
// secret is ever reachable by the model.
//
// @flue 1.0 workflow model: the agent (execution policy + sandbox) is defined
// with `defineAgent`, and the finite behavior is an inline Action bound with
// `defineWorkflow`. The Action's `run` receives `{ harness, log, input }` --
// deliberately NOT platform bindings -- so env-scoped work (repo hydration,
// GitHub auth) reads the bindings back through `getCloudflareContext()`. The
// Workspace is keyed by the Durable Object identity so the sandbox built in the
// agent initializer and the clone performed in the Action target the exact same
// DO SQLite + R2 namespace.

import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import {
	defineAgent,
	defineWorkflow,
	type ActionContext,
	type WorkflowRouteHandler,
} from "@flue/runtime";
import { getCloudflareContext, getDurableObjectIdentity } from "@flue/runtime/cloudflare";
import * as v from "valibot";

import { withCapacityRetry } from "../lib/capacity.js";
import {
	readAppCreds,
	mintInstallationToken,
	fetchUnifiedDiff,
	fetchPullRequestHeadSha,
	fetchPriorReview,
	postReview,
	addEyesReaction,
	removeReaction,
	updateReviewCheck,
} from "../lib/github.js";
import { reviewResultSchema, type ReviewResult } from "../lib/review-schema.js";
import {
	getReviewWatchdog,
	type ReviewStage,
	type ReviewTerminal,
} from "../lib/review-watchdog.js";
import { getDefaultWorkspace, getShellSandbox } from "../sandboxes/cloudflare-shell.js";
import review from "../skills/review/SKILL.md" with { type: "skill" };

const reviewPayloadSchema = v.object({
	prNumber: v.number(),
	prTitle: v.string(),
	prBody: v.string(),
	headRef: v.string(),
	// Optional only so persisted pre-observability runs remain readable; run() fails closed without them.
	headSha: v.optional(v.string()),
	baseRef: v.string(),
	baseSha: v.optional(v.string()),
	owner: v.string(),
	repo: v.string(),
	attemptId: v.optional(v.string()),
	deliveryId: v.optional(v.string()),
	checkRunId: v.optional(v.number()),
});

type ReviewPayload = v.InferOutput<typeof reviewPayloadSchema>;

const REPO_DIR = "/repo";
const DIFF_PATH = `${REPO_DIR}/.flue-pr.diff`;
const HYDRATED = `${REPO_DIR}/.flue-hydrated`;

const NAME = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;
const SHA = /^[0-9a-f]{40}$/i;

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
	for (const [key, value] of [
		["baseSha", payload.baseSha],
		["headSha", payload.headSha],
	] as const) {
		if (value !== undefined && !SHA.test(value))
			throw new Error(`payload.${key} is not a full SHA`);
	}
}

// Stable per-run Workspace name shared by the agent initializer (sandbox) and
// the Action (clone). Both run inside the same workflow-run Durable Object and
// therefore share one DO SqlStorage regardless of this name -- SQLite isolation
// comes from the per-run DO, not the name. The name only keys the R2 large-file
// spill prefix (r2://<name>/...) and observability, so the two call sites must
// derive it identically, otherwise the sandbox and the clone would look for
// spilled git objects under different prefixes. The DO id is a run-unique,
// retry-stable key (same runId -> same DO).
function workspaceName(): string {
	return `review-${getDurableObjectIdentity().id}`;
}

function workflowRunId(): string {
	return getDurableObjectIdentity().name;
}

// The agent: execution policy (model, reasoning effort) plus the cf-shell
// sandbox built from the platform bindings. Repo hydration cannot live here --
// the initializer has no access to the PR payload -- so it moves into the
// Action's `run` below, which shares this sandbox via the same Workspace name.
const reviewAgent = defineAgent<Env>(({ env }) => {
	const workspace = getDefaultWorkspace(env.REVIEW_WORKSPACE, workspaceName());
	return {
		// Kimi K2.7 Code via the Workers AI binding: no model API key needed.
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

// Hydrate the PR into the durable Workspace via JS git (shallow clone of base,
// then fetch + checkout the PR head -- refs/pull/N/head covers fork PRs). Large
// objects (the git packfile) spill to R2 under the workspace name. Idempotent:
// a HYDRATED marker skips re-cloning on workflow re-entry.
async function hydrate(env: Env, payload: ReviewPayload): Promise<void> {
	const workspace = getDefaultWorkspace(env.REVIEW_WORKSPACE, workspaceName());
	if (await workspace.exists(HYDRATED)) return;

	const fs = new WorkspaceFileSystem(workspace);
	const cloneUrl = `https://github.com/${payload.owner}/${payload.repo}.git`;
	const git = createGit(fs);
	await git.clone({
		url: cloneUrl,
		dir: REPO_DIR,
		branch: payload.baseRef,
		singleBranch: true,
		depth: 1,
	});
	const fetched = await git.fetch({
		ref: `pull/${payload.prNumber}/head`,
		depth: 1,
		dir: REPO_DIR,
	});
	if (!fetched.fetchHead) throw new Error("PR head fetch did not return a commit");
	if (payload.headSha && fetched.fetchHead.toLowerCase() !== payload.headSha.toLowerCase()) {
		throw new Error("PR head changed after the review was requested");
	}
	await git.checkout({ ref: fetched.fetchHead, dir: REPO_DIR, force: true });
	await workspace.writeFile(HYDRATED, new Date().toISOString());
}

function logReviewEvent(
	level: "log" | "error",
	payload: ReviewPayload,
	runId: string,
	message: string,
	extra: Record<string, unknown> = {},
): void {
	console[level](
		JSON.stringify({
			message,
			attemptId: payload.attemptId,
			runId,
			deliveryId: payload.deliveryId,
			prNumber: payload.prNumber,
			headSha: payload.headSha,
			checkRunId: payload.checkRunId,
			...extra,
		}),
	);
}

async function reportStage(
	env: Env,
	token: string | undefined,
	payload: ReviewPayload,
	runId: string,
	stage: ReviewStage,
	detail: string,
): Promise<boolean> {
	logReviewEvent("log", payload, runId, "review stage changed", { stage });
	if (payload.checkRunId === undefined || !payload.attemptId) return true;

	const active = await getReviewWatchdog(env, payload.attemptId).heartbeat(
		payload.attemptId,
		stage,
	);
	if (!active) return false;
	if (token) {
		try {
			await updateReviewCheck(token, payload.owner, payload.repo, payload.checkRunId, {
				prNumber: payload.prNumber,
				runId,
				stage,
				detail,
			});
		} catch (error) {
			logReviewEvent("error", payload, runId, "review stage reporting failed", {
				stage,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return true;
}

async function finishReviewCheck(
	env: Env,
	payload: ReviewPayload,
	runId: string,
	terminal: ReviewTerminal,
): Promise<void> {
	if (payload.checkRunId === undefined || !payload.attemptId) return;
	try {
		const finished = await getReviewWatchdog(env, payload.attemptId).finish(
			payload.attemptId,
			terminal,
		);
		if (!finished) {
			logReviewEvent("error", payload, runId, "review attempt was already terminal");
		}
	} catch (error) {
		logReviewEvent("error", payload, runId, "review completion reporting failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function run(context: ActionContext<typeof reviewPayloadSchema>): Promise<ReviewResult> {
	const payload = context.input;

	// ActionContext intentionally excludes platform bindings; read them back
	// through the Cloudflare context established for this workflow run.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const env = getCloudflareContext().env as unknown as Env;
	let runId = payload.attemptId ?? "unidentified";

	// GitHub access lives only in this trusted Action code, never in the agent's
	// workspace. Without app creds (local dev) we skip posting and return.
	const creds = readAppCreds(env);
	let token: string | undefined;
	let priorReview: string | undefined;
	let reactionId: number | undefined;
	let stage: ReviewStage = "admitted";
	try {
		assertSafe(payload);
		if (!payload.headSha || !payload.baseSha) {
			throw new Error("Review payload does not include immutable base and head SHAs");
		}
		runId = workflowRunId();
		if (
			payload.attemptId &&
			payload.checkRunId !== undefined &&
			!(await getReviewWatchdog(env, payload.attemptId).identify(payload.attemptId, runId))
		) {
			throw new Error("Review attempt is no longer active");
		}
		if (creds) {
			token = await mintInstallationToken(creds);
			reactionId = await addEyesReaction(token, payload.owner, payload.repo, payload.prNumber);
			priorReview = await fetchPriorReview(token, payload.owner, payload.repo, payload.prNumber);
		}

		// Hydrate the Workspace (clone + checkout the PR head) into the same DO
		// SQLite + R2 namespace the agent's sandbox reads from.
		stage = "hydrating";
		if (
			!(await reportStage(env, token, payload, runId, "hydrating", "Preparing the PR workspace."))
		) {
			throw new Error("Review attempt is no longer active");
		}
		await hydrate(env, payload);

		const session = await context.harness.session();

		// Stage the canonical unified diff into the Workspace (no `git` in cf-shell).
		stage = "fetching_diff";
		if (
			!(await reportStage(
				env,
				token,
				payload,
				runId,
				"fetching_diff",
				"Fetching the canonical PR diff.",
			))
		) {
			throw new Error("Review attempt is no longer active");
		}
		const diff = await fetchUnifiedDiff(
			payload.owner,
			payload.repo,
			payload.prNumber,
			token,
			payload.baseSha,
			payload.headSha,
		);
		await context.harness.fs.writeFile(DIFF_PATH, diff);

		stage = "model_review";
		if (
			!(await reportStage(
				env,
				token,
				payload,
				runId,
				"model_review",
				"The model is reviewing the diff.",
			))
		) {
			throw new Error("Review attempt is no longer active");
		}
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
				perAttemptTimeoutMs: 30 * 60_000,
				onRetry: ({ attempt, delayMs, error }) =>
					context.log.warn?.("[review] model over capacity, backing off", {
						prNumber: payload.prNumber,
						attempt,
						delayMs,
						error: String(error),
					}),
			},
		);

		logReviewEvent("log", payload, runId, "review model result received", {
			hasToken: Boolean(token),
			verdict: data.verdict,
			summaryLength: data.summary.length,
			findingCount: data.findings.length,
		});

		if (token) {
			stage = "posting_review";
			if (
				!(await reportStage(
					env,
					token,
					payload,
					runId,
					"posting_review",
					"Posting the review to GitHub.",
				))
			) {
				throw new Error("Review attempt is no longer active");
			}
			if (payload.headSha) {
				const currentHeadSha = await fetchPullRequestHeadSha(
					token,
					payload.owner,
					payload.repo,
					payload.prNumber,
				);
				if (currentHeadSha.toLowerCase() !== payload.headSha.toLowerCase()) {
					throw new Error("PR head changed before the review could be posted");
				}
			}
			await postReview(
				token,
				payload.owner,
				payload.repo,
				payload.prNumber,
				data,
				payload.headSha,
				payload.attemptId,
			);
		} else {
			logReviewEvent("log", payload, runId, "GitHub App credentials unavailable; skipping post");
		}

		await finishReviewCheck(env, payload, runId, {
			conclusion: "success",
			summary: `The automated review completed with verdict \`${data.verdict}\` and ${data.findings.length} finding(s).`,
		});

		return data;
	} catch (error) {
		logReviewEvent("error", payload, runId, "review run failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		const errorName = error instanceof Error ? error.name : "Error";
		await finishReviewCheck(env, payload, runId, {
			conclusion: "failure",
			summary: `The review failed during the \`${stage}\` stage (\`${errorName}\`). Reapply the \`bot:review\` label to retry.`,
		});
		throw error;
	} finally {
		if (token && reactionId !== undefined) {
			await removeReaction(token, payload.owner, payload.repo, payload.prNumber, reactionId);
		}
	}
}

export default defineWorkflow({
	agent: reviewAgent,
	input: reviewPayloadSchema,
	output: reviewResultSchema,
	run,
});

// Enable POST /workflows/review (the internal admission route the webhook
// handler calls). Pass-through: admission control lives in the webhook handler.
export const route: WorkflowRouteHandler = async (_c, next) => next();
