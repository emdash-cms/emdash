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
	fetchPriorReview,
	postReview,
	addEyesReaction,
	removeReaction,
} from "../lib/github.js";
import { reviewResultSchema, type ReviewResult } from "../lib/review-schema.js";
import { getDefaultWorkspace, getShellSandbox } from "../sandboxes/cloudflare-shell.js";
import review from "../skills/review/SKILL.md" with { type: "skill" };

const reviewPayloadSchema = v.object({
	prNumber: v.number(),
	prTitle: v.string(),
	prBody: v.string(),
	headRef: v.string(),
	baseRef: v.string(),
	owner: v.string(),
	repo: v.string(),
});

type ReviewPayload = v.InferOutput<typeof reviewPayloadSchema>;

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

// The agent: execution policy (model, reasoning effort) plus the cf-shell
// sandbox built from the platform bindings. Repo hydration cannot live here --
// the initializer has no access to the PR payload -- so it moves into the
// Action's `run` below, which shares this sandbox via the same Workspace name.
const reviewAgent = defineAgent<Env>(({ env }) => {
	const workspace = getDefaultWorkspace(env.REVIEW_WORKSPACE, workspaceName());
	return {
		// GLM-5.2 via the Workers AI binding: no model API key needed. A reasoning
		// model, so `thinkingLevel` maps to `reasoning_effort` on the call; "low"
		// keeps it from over-deliberating on straightforward diffs.
		model: "cloudflare/@cf/zai-org/glm-5.2",
		thinkingLevel: "low",
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
	if (fetched.fetchHead) {
		await git.checkout({ ref: fetched.fetchHead, dir: REPO_DIR, force: true });
	}
	await workspace.writeFile(HYDRATED, new Date().toISOString());
}

async function run(context: ActionContext<typeof reviewPayloadSchema>): Promise<ReviewResult> {
	const payload = context.input;
	assertSafe(payload);

	// ActionContext intentionally excludes platform bindings; read them back
	// through the Cloudflare context established for this workflow run.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const env = getCloudflareContext().env as unknown as Env;

	// GitHub access lives only in this trusted Action code, never in the agent's
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
		// Hydrate the Workspace (clone + checkout the PR head) into the same DO
		// SQLite + R2 namespace the agent's sandbox reads from.
		await hydrate(env, payload);

		const session = await context.harness.session();

		// Stage the canonical unified diff into the Workspace (no `git` in cf-shell).
		const diff = await fetchUnifiedDiff(payload.owner, payload.repo, payload.prNumber, token);
		await context.harness.fs.writeFile(DIFF_PATH, diff);

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

export default defineWorkflow({
	agent: reviewAgent,
	input: reviewPayloadSchema,
	output: reviewResultSchema,
	run,
});

// Enable POST /workflows/review (the internal admission route the webhook
// handler calls). Pass-through: admission control lives in the webhook handler.
export const route: WorkflowRouteHandler = async (_c, next) => next();
