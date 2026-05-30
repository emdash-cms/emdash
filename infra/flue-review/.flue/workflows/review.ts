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

import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";
import { cfSandboxToSessionEnv } from "@flue/runtime/cloudflare";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

import { reviewResultSchema, type ReviewResult } from "../lib/review-schema.js";
import {
	readAppCreds,
	mintInstallationToken,
	fetchPriorReview,
	postReview,
	addEyesReaction,
	removeReaction,
} from "../lib/github.js";
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

// Kimi via the Cloudflare Workers AI binding: the `cloudflare/` prefix is
// reserved by Flue's generated CF entry and routed through `env.AI`, so no
// model API key is needed anywhere.
const reviewAgent = createAgent<ReviewPayload, Env>(({ env }) => ({
	model: "cloudflare/@cf/moonshotai/kimi-k2.6",
	// The container's working dir is the checked-out PR. AGENTS.md at the repo
	// root is auto-discovered into the agent's context from here.
	cwd: "/workspace",
	// Wire the @cloudflare/sandbox container into Flue via its CF adapter.
	// (The deploy doc's bare `sandbox: getSandbox(...)` is unreleased sugar; on
	// @flue/runtime 0.8.1 the supported path is a SandboxFactory that calls
	// cfSandboxToSessionEnv.) `id` here is the per-session id Flue supplies, so
	// each review run gets its own container instance.
	sandbox: {
		createSessionEnv: ({ id: sessionId, cwd: sessionCwd }) =>
			cfSandboxToSessionEnv(
				getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sessionId),
				sessionCwd ?? "/workspace",
			),
	},
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
// Git ref: segments of safe chars joined by "/". No leading "-", no "..".
const REF = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

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
		const harness = await init(reviewAgent);
		const session = await harness.session();

		// Set up the checkout inside the container: init in /workspace, fetch the
		// base branch and the PR head, check out the PR head (detached). Full fetch
		// (no shallow/depth) so `git diff origin/<base>...HEAD` can resolve a merge
		// base. emdash is public, so anonymous https is sufficient.
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

		const setupResult = await session.shell(setup);
		if (setupResult.exitCode !== 0) {
			throw new Error(
				`git setup failed (exit ${setupResult.exitCode}): ${setupResult.stderr || setupResult.stdout}`,
			);
		}

		const { data } = await session.skill(review, {
			args: {
				prContext: buildPrContext(payload, priorReview),
				owner: payload.owner,
				repo: payload.repo,
				prNumber: payload.prNumber,
				baseRef: payload.baseRef,
				headRef: payload.headRef,
			},
			result: reviewResultSchema,
		});

		// Post from this trusted DO context (durable, not bound by the webhook's
		// 30s waitUntil budget). In dev (no creds) we just log and return.
		if (token) {
			await postReview(token, payload.owner, payload.repo, payload.prNumber, data);
		} else {
			ctx.log.info?.("[review] no GitHub App creds; skipping post", { prNumber: payload.prNumber });
		}

		return data;
	} finally {
		// Clear the in-progress marker whether the review posted or threw.
		if (token && reactionId !== undefined) {
			await removeReaction(token, payload.owner, payload.repo, payload.prNumber, reactionId);
		}
	}
}
