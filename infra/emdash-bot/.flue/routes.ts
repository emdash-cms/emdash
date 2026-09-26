// Core bot routes (dashboard, health, /webhook/github). Separated from app.ts so the
// workers-pool test entry can mount them without pulling in Flue's
// workflow-invoke routes (which require workflow DOs that aren't declared in
// wrangler.test.jsonc).

import type { Hono } from "hono";

import dashboardHtml from "./dashboard.html?raw";
import { dashboardIssueUpdate, getDashboardPayload } from "./lib/dashboard.js";
import { githubRateLimitGate } from "./lib/github-rate-limit-client.js";
import {
	getPullRequestHeadBranch,
	getPullRequestReviewComments,
	readRepoContext,
	type GitHubToken,
} from "./lib/github.js";
import { syncReviewStateLabel } from "./lib/review-state.js";
import {
	normalizeWebhook,
	resolvePullRequestWebhook,
	verifyWebhookSignature,
} from "./lib/webhook.js";

const WEBHOOK_GITHUB_LOOKUP_TIMEOUT_MS = 8_000;
const OPERATOR_IDEMPOTENCY_KEY = /^[a-zA-Z0-9._-]+$/;

async function coordinatedInstallationToken(env: Env, consumer: string): Promise<GitHubToken> {
	const gate = githubRateLimitGate(env);
	const token = await gate.getInstallationToken();
	return { token, gate, consumer };
}

export function registerCoreRoutes(app: Hono<{ Bindings: Env }>): Hono<{ Bindings: Env }> {
	app.get("/", (c) => c.html(dashboardHtml));
	app.get("/health", (c) => c.text("ok"));
	app.get("/api/operator/orchestrators/:id/recovery", async (c) => {
		if (
			!(await operatorAuthorized(c.req.header("authorization"), c.env.EMDASH_BOT_OPERATOR_SECRET))
		) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		try {
			const id = c.env.Orchestrator.idFromString(c.req.param("id"));
			return c.json(await c.env.Orchestrator.get(id).inspectRecoveryState());
		} catch {
			return c.json({ error: "Invalid orchestrator id" }, 400);
		}
	});
	app.post("/api/operator/orchestrators/:id/recovery/settle", async (c) => {
		if (
			!(await operatorAuthorized(c.req.header("authorization"), c.env.EMDASH_BOT_OPERATOR_SECRET))
		) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}
		if (!body || typeof body !== "object") return c.json({ error: "Invalid request" }, 400);
		const input = Object.fromEntries(Object.entries(body));
		if (
			typeof input.expectedAnchorNumber !== "number" ||
			!Number.isSafeInteger(input.expectedAnchorNumber) ||
			typeof input.expectedRunId !== "string" ||
			input.expectedRunId.length === 0 ||
			(input.clearInbox !== undefined && typeof input.clearInbox !== "boolean")
		) {
			return c.json({ error: "Invalid request" }, 400);
		}
		try {
			const id = c.env.Orchestrator.idFromString(c.req.param("id"));
			const result = await c.env.Orchestrator.get(id).settleStaleRun({
				expectedAnchorNumber: input.expectedAnchorNumber,
				expectedRunId: input.expectedRunId,
				...(input.clearInbox === true ? { clearInbox: true } : {}),
			});
			return c.json(result, result.settled ? 200 : 409);
		} catch {
			return c.json({ error: "Invalid orchestrator id" }, 400);
		}
	});
	app.get("/api/operator/issues/:number/recovery", async (c) => {
		if (
			!(await operatorAuthorized(c.req.header("authorization"), c.env.EMDASH_BOT_OPERATOR_SECRET))
		) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const issueNumber = positiveInteger(c.req.param("number"));
		if (issueNumber === null) return c.json({ error: "Invalid issue number" }, 400);
		return c.json(
			await c.env.Orchestrator.getByName(`issue-${issueNumber}`).inspectRecoveryState(),
		);
	});
	app.post("/api/operator/issues/:number/command", async (c) => {
		if (
			!(await operatorAuthorized(c.req.header("authorization"), c.env.EMDASH_BOT_OPERATOR_SECRET))
		) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const issueNumber = positiveInteger(c.req.param("number"));
		if (issueNumber === null) return c.json({ error: "Invalid issue number" }, 400);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}
		if (!body || typeof body !== "object") return c.json({ error: "Invalid request" }, 400);
		const { command, expectedState, idempotencyKey } = Object.fromEntries(Object.entries(body));
		if (
			(command !== "retry" && command !== "work") ||
			(expectedState !== "needs_attention" &&
				expectedState !== "failed" &&
				expectedState !== "blocked" &&
				expectedState !== "awaiting_approval")
		) {
			return c.json({ error: "Invalid request" }, 400);
		}
		if (
			typeof idempotencyKey !== "string" ||
			idempotencyKey.length === 0 ||
			idempotencyKey.length > 100 ||
			!OPERATOR_IDEMPOTENCY_KEY.test(idempotencyKey)
		) {
			return c.json({ error: "Invalid request" }, 400);
		}
		const result = await c.env.Orchestrator.getByName(`issue-${issueNumber}`).queueOperatorCommand({
			expectedAnchorNumber: issueNumber,
			command,
			expectedState,
			idempotencyKey,
		});
		return c.json(result, result.queued ? 202 : 409);
	});
	app.get("/api/dashboard", async (c) => {
		try {
			const payload = await getDashboardPayload(c.env);
			c.header("cache-control", "public, max-age=10, stale-while-revalidate=30");
			return c.json(payload);
		} catch (error) {
			console.error("[dashboard] load failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return c.json({ error: "Dashboard data is temporarily unavailable" }, 503);
		}
	});
	app.get("/api/issues/:number/trace", async (c) => {
		const issueNumber = Number(c.req.param("number"));
		if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
			return c.json({ error: "Invalid issue number" }, 400);
		}
		const beforeValue = c.req.query("before");
		const limitValue = c.req.query("limit");
		const before = beforeValue === undefined ? undefined : Number(beforeValue);
		const limit = limitValue === undefined ? undefined : Number(limitValue);
		if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
			return c.json({ error: "Invalid trace cursor" }, 400);
		}
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
			return c.json({ error: "Invalid trace limit" }, 400);
		}
		try {
			const { Orchestrator } = c.env;
			const runId = c.req.query("run");
			const trace = await Orchestrator.getByName(`issue-${issueNumber}`).getPublicRunTrace({
				...(runId ? { runId } : {}),
				...(before === undefined ? {} : { before }),
				...(limit === undefined ? {} : { limit }),
			});
			c.header("cache-control", "no-store");
			return c.json(trace);
		} catch (error) {
			console.error("[dashboard] trace load failed", {
				issueNumber,
				error: error instanceof Error ? error.message : String(error),
			});
			return c.json({ error: "Run trace is temporarily unavailable" }, 503);
		}
	});

	app.post("/webhook/github", async (c) => {
		// Verify signature against the RAW body, before any parsing. Round-tripping
		// through JSON.parse + stringify would reorder keys and break the HMAC.
		const raw = await c.req.text();
		const secret = c.env.GITHUB_WEBHOOK_SECRET;
		if (!secret) return c.text("webhook secret not configured", 500);
		const valid = await verifyWebhookSignature(secret, raw, c.req.header("x-hub-signature-256"));
		if (!valid) return c.text("invalid signature", 401);

		const eventType = c.req.header("x-github-event") ?? "";
		const deliveryId = c.req.header("x-github-delivery") ?? undefined;

		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			return c.text("invalid JSON", 400);
		}
		const dashboardUpdate = dashboardIssueUpdate(payload);
		if (dashboardUpdate) {
			const repo = readRepoContext(c.env);
			if (repo) {
				c.executionCtx.waitUntil(
					c.env.DASHBOARD.getByName(`repo:${repo.owner}/${repo.repo}`)
						.recordIssue(dashboardUpdate)
						.catch((error: unknown) => {
							console.error("[dashboard] webhook update failed", error);
						}),
				);
			}
		}

		let result = normalizeWebhook({ eventType, deliveryId, payload });
		if (result.kind === "pong") {
			console.log("[webhook] ping", { delivery: deliveryId });
			return c.text("pong", 200);
		}
		// issue_comment payloads identify a PR but omit its head ref, which is
		// the trusted link back to the originating issue lifecycle.
		if (result.kind === "pull_request") {
			const unresolved = result;
			const repo = readRepoContext(c.env);
			if (!repo) return c.text("GitHub integration not configured", 503);
			try {
				const signal = AbortSignal.timeout(WEBHOOK_GITHUB_LOOKUP_TIMEOUT_MS);
				const token = await coordinatedInstallationToken(
					c.env,
					`webhook-pr-lookup:${deliveryId ?? unresolved.pullRequestNumber}`,
				);
				const headBranch = await getPullRequestHeadBranch(
					token,
					repo,
					unresolved.pullRequestNumber,
					signal,
				);
				result = resolvePullRequestWebhook(unresolved, headBranch);
			} catch (error) {
				console.error("[webhook] pull request lookup failed", {
					event: eventType,
					delivery: deliveryId,
					pullRequest: unresolved.pullRequestNumber,
					error: error instanceof Error ? error.message : String(error),
				});
				return c.text("pull request lookup failed", 503);
			}
		}
		if (result.kind === "dispatch" && result.event.reviewId && result.event.pullRequestNumber) {
			const repo = readRepoContext(c.env);
			if (!repo) return c.text("GitHub integration not configured", 503);
			try {
				const signal = AbortSignal.timeout(WEBHOOK_GITHUB_LOOKUP_TIMEOUT_MS);
				const token = await coordinatedInstallationToken(
					c.env,
					`webhook-review-comments:${deliveryId ?? result.event.reviewId}`,
				);
				const comments = await getPullRequestReviewComments(
					token,
					repo,
					result.event.pullRequestNumber,
					result.event.reviewId,
					signal,
				);
				const body = [result.event.triggeringComment?.body.trim(), ...comments]
					.filter(Boolean)
					.join("\n\n");
				if (!body) return c.text("skipped: review has no feedback", 202);
				result = {
					...result,
					event: {
						...result.event,
						arg: body,
						...(result.event.triggeringComment
							? { triggeringComment: { ...result.event.triggeringComment, body } }
							: {}),
					},
				};
			} catch (error) {
				console.error("[webhook] review comments lookup failed", {
					delivery: deliveryId,
					error: error instanceof Error ? error.message : String(error),
				});
				return c.text("review comments lookup failed", 503);
			}
		}

		if (result.kind === "skip") {
			console.log("[webhook] skip", {
				event: eventType,
				delivery: deliveryId,
				reason: result.reason,
			});
			return c.text(`skipped: ${result.reason}`, 202);
		}

		// Issue-close cleanup reaps the fix-loop branches directly (a few fast
		// GitHub calls, well within the ack budget); it is not a machine event,
		// so it bypasses the DO inbox and runs synchronously.
		if (result.kind === "cleanup") {
			const stub = c.env.Orchestrator.getByName(result.anchor);
			const cleanup = await stub.cleanupOnClose(result.anchorNumber);
			console.log("[webhook] cleanup", {
				event: eventType,
				delivery: deliveryId,
				anchor: result.anchor,
				cleanup: cleanup.kind,
			});
			return c.json({ anchor: result.anchor, cleanup }, 202);
		}
		if (result.kind === "review_state") {
			const repo = readRepoContext(c.env);
			if (!repo) return c.text("GitHub integration not configured", 503);
			try {
				const signal = AbortSignal.timeout(WEBHOOK_GITHUB_LOOKUP_TIMEOUT_MS);
				const token = await coordinatedInstallationToken(
					c.env,
					`webhook-review-state:${deliveryId ?? result.pullRequestNumber}`,
				);
				const reviewState = await syncReviewStateLabel(token, repo, result, signal);
				console.log("[webhook] review state", {
					delivery: deliveryId,
					pullRequest: result.pullRequestNumber,
					reviewState,
				});
				return c.json({ pullRequest: result.pullRequestNumber, reviewState }, 202);
			} catch (error) {
				console.error("[webhook] review state update failed", {
					delivery: deliveryId,
					pullRequest: result.pullRequestNumber,
					error: error instanceof Error ? error.message : String(error),
				});
				return c.text("review state update failed", 503);
			}
		}
		if (result.kind !== "dispatch") return c.text("unsupported webhook result", 500);

		// Persist into the per-anchor OrchestratorDO inbox before acknowledging.
		// Classification, dispatch, and GitHub effects run from the DO alarm so
		// GitHub does not time out while the bot performs external work.
		// `x-emdash-dry-run: 1` lets local smoke tests exercise the full
		// pipeline (LLM, sandbox, push) without leaving labels/comments on
		// the GitHub issue. Production webhooks never send this header.
		const dryRun = c.req.header("x-emdash-dry-run") === "1";
		const stub = c.env.Orchestrator.getByName(result.anchor);
		const admission = await stub.enqueue({ ...result.event, dryRun });
		console.log("[webhook] admitted", {
			event: eventType,
			delivery: deliveryId,
			anchor: result.anchor,
			admission: admission.kind,
		});
		return c.json({ anchor: result.anchor, admission }, 202);
	});

	return app;
}

async function operatorAuthorized(header: string | undefined, secret: string): Promise<boolean> {
	if (!header || !secret) return false;
	const expected = `Bearer ${secret}`;
	const encoder = new TextEncoder();
	const providedBytes = encoder.encode(header);
	const expectedBytes = encoder.encode(expected);
	return (
		providedBytes.byteLength === expectedBytes.byteLength &&
		crypto.subtle.timingSafeEqual(providedBytes, expectedBytes)
	);
}

function positiveInteger(value: string): number | null {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
