// Custom Flue application: the GitHub App webhook orchestrator.
//
// This is the ONLY public surface. We deliberately do NOT mount flue() at a
// public path, so the workflow/agent HTTP endpoints are not externally
// reachable; the workflow is admitted only via an internal request from this
// handler. The handler does no long-running work itself (a webhook must ack
// within seconds, and waitUntil caps at 30s): it verifies, gates, reserves a
// durable attempt, and returns. The watchdog creates the check and admits the
// workflow from an alarm; the review and GitHub post happen in durable state.

import { getRun, listRuns, registerProvider } from "@flue/runtime";
import { env } from "cloudflare:workers";
import { Hono } from "hono";

import { createAiPayloadGuard } from "./lib/ai-payload-budget.js";
import { getReviewWatchdog, type ReviewAttempt } from "./lib/review-watchdog.js";
import {
	verifyWebhookSignature,
	gatePullRequestEvent,
	getWebhookDeliveryId,
} from "./lib/webhook.js";

registerProvider("cloudflare", {
	api: "cloudflare-ai-binding",
	binding: createAiPayloadGuard(env.AI),
});

// Extract a short, displayable message from an unknown run error without
// risking an "[object Object]" stringification.
function formatRunError(err: unknown): string | undefined {
	if (err === undefined || err === null) return undefined;
	if (err instanceof Error) return err.message.slice(0, 200);
	if (typeof err === "string") return err.slice(0, 200);
	if (typeof err === "object" && "message" in err && typeof err.message === "string") {
		return err.message.slice(0, 200);
	}
	return JSON.stringify(err).slice(0, 200);
}

const app = new Hono<{ Bindings: Env }>();

// Protected admin read of the workflow run-index (sampling-immune ground truth,
// unlike Workers Logs). Lets us compare runs admitted vs reviews posted to see
// whether misses are "never started" or "started and failed". Gated by the
// webhook secret. Note: the FlueRegistry DO was reset 2026-06-21, so history
// only goes back to then.
app.get("/webhook/admin/runs", async (c) => {
	if (c.req.header("x-admin-token") !== c.env.GITHUB_WEBHOOK_SECRET) {
		return c.text("unauthorized", 401);
	}
	const statusParam = c.req.query("status");
	const status =
		statusParam === "active" || statusParam === "completed" || statusParam === "errored"
			? statusParam
			: undefined;
	const result = await listRuns({ limit: 100, ...(status ? { status } : {}) });
	const runs = result.runs ?? [];
	const summary = { active: 0, completed: 0, errored: 0, other: 0 };
	for (const r of runs) {
		if (r.status === "active") summary.active++;
		else if (r.status === "completed") summary.completed++;
		else if (r.status === "errored") summary.errored++;
		else summary.other++;
	}

	// ?detail=1: pull the full RunRecord (input/result/error) for each run via
	// getRun, to see whether the Cloudflare registry persists those (needed to
	// map a run -> PR and to read the failure reason).
	if (c.req.query("detail") === "1") {
		const detailed = await Promise.all(
			runs.slice(0, 25).map(async (r) => {
				const rec = (await getRun(r.runId).catch(() => null)) as {
					input?: unknown;
					error?: unknown;
					result?: unknown;
				} | null;
				const payload = rec?.input;
				const prNumber =
					typeof payload === "object" &&
					payload !== null &&
					"prNumber" in payload &&
					typeof payload.prNumber === "number"
						? payload.prNumber
						: undefined;
				return {
					runId: r.runId,
					workflowName: r.workflowName,
					status: r.status,
					startedAt: r.startedAt,
					endedAt: r.endedAt,
					durationMs: r.durationMs,
					isError: r.isError,
					prNumber,
					hasInput: rec?.input !== undefined,
					hasResult: rec?.result !== undefined,
					error: formatRunError(rec?.error),
				};
			}),
		);
		return c.json({ total: runs.length, summary, detailed });
	}

	return c.json({ total: runs.length, summary, runs });
});

app.post("/webhook/github", async (c) => {
	const raw = await c.req.text();
	const secret = c.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) return c.text("webhook secret not configured", 500);
	const valid = await verifyWebhookSignature(secret, raw, c.req.header("x-hub-signature-256"));
	if (!valid) return c.text("invalid signature", 401);

	const eventType = c.req.header("x-github-event");
	console.log("[webhook] received", {
		event: eventType,
		delivery: c.req.header("x-github-delivery"),
	});
	if (eventType === "ping") return c.text("pong", 200);
	if (eventType !== "pull_request") return c.text(`ignored event: ${eventType}`, 202);

	let event: Parameters<typeof gatePullRequestEvent>[0];
	try {
		event = JSON.parse(raw);
	} catch {
		return c.text("invalid JSON", 400);
	}

	const decision = gatePullRequestEvent(event);
	console.log("[webhook] decision", {
		action: event.action,
		prNumber: event.pull_request?.number,
		review: decision.review,
		reason: decision.review ? undefined : decision.reason,
	});
	if (!decision.review) return c.text(`skipped: ${decision.reason}`, 202);

	const deliveryId = getWebhookDeliveryId(c.req.header("x-github-delivery"));
	if (!deliveryId) return c.text("missing delivery id", 400);
	const attemptId = deliveryId;
	const setupLease = crypto.randomUUID();
	const watchdog = getReviewWatchdog(c.env, attemptId);
	const reservedAttempt: ReviewAttempt = {
		attemptId,
		runId: attemptId,
		deliveryId,
		owner: decision.pr.owner,
		repo: decision.pr.repo,
		prNumber: decision.pr.prNumber,
		headSha: decision.pr.headSha,
		workflowInput: decision.pr,
		stage: "admitted",
		lastProgressAt: Date.now(),
	};
	const reservation = await watchdog.reserve(reservedAttempt, setupLease);
	if (reservation.status === "busy") {
		return c.text("review setup already in progress", 202);
	}
	if (reservation.status === "complete") {
		return c.text("duplicate delivery", 200);
	}
	return c.json({ message: `review setup queued for PR #${decision.pr.prNumber}`, attemptId }, 202);
});

export default app;
