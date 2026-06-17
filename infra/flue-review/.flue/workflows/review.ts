// Review workflow (Cloudflare target).
//
// Reviews one pull request and returns structured findings plus a verdict. It
// does NOT post to GitHub: the workflow result is returned over HTTP and a
// separate orchestrator (the GitHub App webhook handler, Phase B) posts the
// review with a write-scoped installation token.
//
// Security model: the agent runs inside a @cloudflare/sandbox container with
// no GitHub token in its environment. emdash is a public repo, so the container
// clones it over anonymous https; nothing secret is ever exposed to the
// model-directed shell. The reviewer is git-only (no `gh`): it diffs the PR
// head against the base locally. Posting (Phase B) happens outside this
// container via the egress proxy, so the token never enters model-reachable
// space.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
	createAgent,
	type FlueContext,
	type SandboxFactory,
	type WorkflowRouteHandler,
} from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";

import { withCapacityRetry } from "../lib/capacity.js";
import {
	readAppCreds,
	mintInstallationToken,
	fetchPriorReview,
	postReview,
	addEyesReaction,
	removeReaction,
} from "../lib/github.js";
import { reviewResultSchema, type ReviewResult } from "../lib/review-schema.js";
// Bundled as a SkillReference by the Flue build. Holds the full investigation
// protocol (git-only, ported from the ask-bonk auto-reviewer).
import review from "../skills/review/SKILL.md" with { type: "skill" };

interface ReviewPayload {
	prNumber: number;
	prTitle: string;
	prBody: string;
	/** Head ref name (informational; the head commit is fetched via pull/N/head). */
	headRef: string;
	/** Base branch name, e.g. "main". The diff is taken against origin/<baseRef>. */
	baseRef: string;
	owner: string;
	repo: string;
}

/**
 * Container sandbox factory, wrapping Flue's `cloudflareSandbox(...)` to drop the
 * `AbortSignal` before each `exec()`.
 *
 * `getSandbox(...).exec(command, options)` is a Worker -> Durable Object RPC call
 * (the @cloudflare/sandbox SDK forwards the whole options bag, including any
 * `AbortSignal`, to the Sandbox DO). An `AbortSignal` created outside the target
 * DO cannot cross that RPC boundary -- the call hangs forever and the command
 * never runs. Flue's session/agent shell path *always* attaches a signal (via
 * `createCallHandle`), so every container command -- our git setup AND the
 * agent's own bash/grep/find tool calls -- would hang. Verified: an identical
 * `exec` with the signal omitted (or `undefined`) returns in ~50ms; with a live
 * signal it never returns. Holds across @cloudflare/sandbox 0.10.3/0.12.1 and
 * both the `http` and `rpc` transports, so it is not a version/transport issue.
 *
 * We don't need cooperative exec cancellation: the model-call timeout in
 * `withCapacityRetry` bounds a stalled review, and the container has its own
 * lifecycle. So we strip the signal. (Upstream: Flue's `cloudflareSandbox`
 * adapter should not forward a cross-DO `AbortSignal` to `exec`.)
 */
function reviewSandbox(stub: DurableObjectNamespace<Sandbox>, id: string): SandboxFactory {
	const base = cloudflareSandbox(getSandbox(stub, id), { cwd: "/workspace" });
	return {
		createSessionEnv: async (options) => {
			const sessionEnv = await base.createSessionEnv(options);
			const exec = sessionEnv.exec.bind(sessionEnv);
			return {
				...sessionEnv,
				exec: (command, execOptions) => exec(command, { ...execOptions, signal: undefined }),
			};
		},
	};
}

// GLM-5.2 (Z.ai's agentic-coding model) via the Cloudflare Workers AI binding:
// the `cloudflare/` prefix is reserved by Flue's generated CF entry and routed
// through `env.AI`, so no model API key is needed anywhere. Workers AI 429s are
// handled by `withCapacityRetry` below.
const reviewAgent = createAgent<ReviewPayload, Env>(({ id, env }) => ({
	model: "cloudflare/@cf/zai-org/glm-5.2",
	// Container-backed Linux sandbox (git/rg). `id` is the per-instance id, so
	// each review run gets its own container. `cwd` is the checked-out PR root.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	sandbox: reviewSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, id),
	cwd: "/workspace",
	instructions: [
		"You are EmDash's automated pull request reviewer.",
		"You investigate one PR in depth and return structured, line-anchored findings plus an overall verdict.",
		"You are read-only: no network writes, no posting. The orchestrator posts your review after you finish.",
		"Follow the review skill's protocol exactly and return strictly schema-conformant output.",
	].join(" "),
	skills: [review],
}));

// Phase A: open endpoint for local validation. Phase B replaces this with HMAC
// webhook-signature verification before calling next().
export const route: WorkflowRouteHandler = async (_c, next) => next();

// GitHub login / repo-name charset.
const NAME = /^[A-Za-z0-9._-]+$/;
// Git ref: "/"-joined segments; each segment must not start with "-" (so the
// value can't be read as a CLI option when interpolated into git). The caller
// also rejects "..".
const REF = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;

function assertSafe(payload: ReviewPayload): void {
	if (!Number.isInteger(payload.prNumber) || payload.prNumber <= 0) {
		throw new Error("payload.prNumber must be a positive integer");
	}
	if (!payload.prTitle) {
		throw new Error("payload.prTitle is required");
	}
	for (const [key, value] of [
		["owner", payload.owner],
		["repo", payload.repo],
	] as const) {
		if (!value || !NAME.test(value)) {
			throw new Error(`payload.${key} is missing or has unsafe characters`);
		}
	}
	for (const [key, value] of [
		["baseRef", payload.baseRef],
		["headRef", payload.headRef],
	] as const) {
		if (!value || !REF.test(value) || value.includes("..")) {
			throw new Error(`payload.${key} is missing or not a safe git ref`);
		}
	}
}

function buildPrContext(payload: ReviewPayload, priorReview?: string): string {
	const lines = [
		`PR #${payload.prNumber} in ${payload.owner}/${payload.repo}.`,
		`Head ref: ${payload.headRef}. Base branch: ${payload.baseRef} (diff against origin/${payload.baseRef}).`,
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

	// GitHub access lives entirely in this trusted DO code, never in the agent's
	// container. Without app creds (e.g. local dev) we skip posting and just
	// return the result. The token (minted once, valid ~1h) is reused for the
	// prior-review fetch and the final post.
	const creds = readAppCreds(env);
	let token: string | undefined;
	let priorReview: string | undefined;
	let reactionId: number | undefined;
	if (creds) {
		token = await mintInstallationToken(creds);
		// Signal "review in progress" before the (minutes-long) container review.
		reactionId = await addEyesReaction(token, payload.owner, payload.repo, payload.prNumber);
		priorReview = await fetchPriorReview(token, payload.owner, payload.repo, payload.prNumber);
	}

	try {
		// Check out the PR into the container BEFORE init(): init in /workspace,
		// fetch the base branch and the PR head, check out the PR head (detached).
		// Full fetch (no shallow/depth) so `git diff origin/<base>...HEAD` can
		// resolve a merge base. emdash is public, so anonymous https is sufficient.
		//
		// Ordering matters: Flue's init-time workspace scan reads `<cwd>/AGENTS.md`
		// and `<cwd>/.agents/skills/*` into the agent's context. The container must
		// already hold the checkout when init() runs, or AGENTS.md is never
		// discovered (the review skill checks the PR against AGENTS.md conventions).
		//
		// We run setup through the raw @cloudflare/sandbox stub (same container id
		// as the agent's sandbox below) with a plain `exec` and no AbortSignal.
		// Flue's shell path always attaches a signal, which hangs across the DO RPC
		// boundary (see reviewSandbox); a direct signal-less exec does not.
		const cloneUrl = `https://github.com/${payload.owner}/${payload.repo}.git`;
		const setup = [
			"set -euo pipefail",
			"cd /workspace",
			"git init -q",
			`git remote add origin ${cloneUrl} 2>/dev/null || git remote set-url origin ${cloneUrl}`,
			`git fetch -q --no-tags origin ${payload.baseRef}:refs/remotes/origin/${payload.baseRef}`,
			`git fetch -q --no-tags origin pull/${payload.prNumber}/head:refs/remotes/origin/pr`,
			"git checkout -q -f refs/remotes/origin/pr",
		].join("\n");

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const containerStub = getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, ctx.id);
		const setupResult = await containerStub.exec(setup);
		if (setupResult.exitCode !== 0) {
			throw new Error(
				`git setup failed (exit ${setupResult.exitCode}): ${setupResult.stderr || setupResult.stdout}`,
			);
		}

		// Init now that /workspace holds the checkout (AGENTS.md is discovered
		// here); the agent's tool calls run against this same container.
		const harness = await init(reviewAgent);
		const session = await harness.session();

		// Workers AI returns 429 when kimi is over capacity, and under sustained
		// load the binding can hold the request open indefinitely. Bound each
		// attempt and retry genuine capacity errors so a transient spike doesn't
		// silently hang the review forever (it used to: no result, no post, just
		// the container's keep-alive alarm firing for minutes).
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
					},
					result: reviewResultSchema,
					signal,
				}),
			{
				label: `review#${payload.prNumber}`,
				attempts: 3,
				perAttemptTimeoutMs: 6 * 60_000,
				onRetry: ({ attempt, delayMs, error }) =>
					ctx.log.warn?.("[review] model over capacity, backing off", {
						prNumber: payload.prNumber,
						attempt,
						delayMs,
						error: String(error),
					}),
			},
		);

		// Telemetry (Workers Logs / dashboard): records what the model produced
		// and whether we're about to post.
		console.log("[review] result", {
			prNumber: payload.prNumber,
			hasToken: Boolean(token),
			verdict: data.verdict,
			summaryLen: data.summary.length,
			findings: data.findings.length,
		});

		// Post from this trusted DO context (durable, not bound by the webhook's
		// 30s waitUntil budget). In dev (no creds) we just log and return.
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
		// Clear the in-progress marker whether the review posted or threw.
		if (token && reactionId !== undefined) {
			await removeReaction(token, payload.owner, payload.repo, payload.prNumber, reactionId);
		}
	}
}
