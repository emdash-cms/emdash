// Custom Flue application: the GitHub App webhook orchestrator.
//
// This is the ONLY public surface. We deliberately do NOT mount flue() at a
// public path, so the workflow/agent HTTP endpoints are not externally
// reachable; the workflow is admitted only via an internal request from this
// handler. The handler does no long-running work itself (a webhook must ack
// within seconds, and waitUntil caps at 30s): it verifies, gates, admits the
// durable workflow run, and returns. The review and the GitHub post happen
// inside the workflow's Durable Object, which is not bound by that budget.

import { getRun, listRuns } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import {
	completeReviewCheck,
	createReviewCheck,
	findReviewCheck,
	mintInstallationToken,
	readAppCreds,
} from "./lib/github.js";
import { getReviewWatchdog, type ReviewAttempt } from "./lib/review-watchdog.js";
import {
	verifyWebhookSignature,
	gatePullRequestEvent,
	getWebhookDeliveryId,
} from "./lib/webhook.js";

const flueApp = flue();

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
		stage: "admitted",
		lastProgressAt: Date.now(),
	};
	const reservation = await watchdog.reserve(reservedAttempt, setupLease);
	if (reservation.status === "busy") {
		return c.text("review setup already in progress", 503);
	}
	if (reservation.status === "complete") {
		return c.text("duplicate delivery", 200);
	}

	const creds = readAppCreds(c.env);
	if (!creds) {
		return c.text("GitHub App credentials not configured", 500);
	}

	let token: string;
	let checkRunId = reservation.attempt.checkRunId;
	try {
		token = await mintInstallationToken(creds);
		if (checkRunId === undefined) {
			checkRunId = await findReviewCheck(
				token,
				decision.pr.owner,
				decision.pr.repo,
				decision.pr.headSha,
				attemptId,
			);
		}
		if (checkRunId === undefined) {
			try {
				checkRunId = await createReviewCheck(token, decision.pr.owner, decision.pr.repo, {
					headSha: decision.pr.headSha,
					attemptId,
					prNumber: decision.pr.prNumber,
				});
			} catch (error) {
				checkRunId = await findReviewCheck(
					token,
					decision.pr.owner,
					decision.pr.repo,
					decision.pr.headSha,
					attemptId,
				);
				if (checkRunId === undefined) throw error;
			}
		}
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "review check creation failed",
				error: error instanceof Error ? error.message : String(error),
				attemptId,
				deliveryId,
				prNumber: decision.pr.prNumber,
				headSha: decision.pr.headSha,
			}),
		);
		return c.text("failed to create review check", 502);
	}

	try {
		await watchdog.arm({ ...reservedAttempt, checkRunId }, setupLease);
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "review watchdog arm failed",
				error: error instanceof Error ? error.message : String(error),
				attemptId,
				deliveryId,
				prNumber: decision.pr.prNumber,
				checkRunId,
			}),
		);
		await completeReviewCheck(token, decision.pr.owner, decision.pr.repo, checkRunId, {
			conclusion: "failure",
			prNumber: decision.pr.prNumber,
			runId: attemptId,
			summary: "The review watchdog could not be armed. Reapply the `bot:review` label to retry.",
		})
			.then(() => watchdog.complete(attemptId))
			.catch(() => undefined);
		return c.text("failed to arm review watchdog", 502);
	}
	if (!(await watchdog.beginAdmission(attemptId, setupLease))) {
		return c.text("duplicate delivery", 200);
	}

	// Admit the durable workflow run (fast). The review + post run in the
	// workflow DO independently of this request. No ?wait=result: we don't
	// block the webhook on the (minutes-long) review.
	let admit: Response;
	try {
		admit = await flueApp.fetch(
			new Request("https://flue.internal/workflows/review", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...decision.pr,
					attemptId,
					deliveryId,
					checkRunId,
				}),
			}),
			c.env,
			c.executionCtx,
		);
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "review workflow admission threw",
				error: error instanceof Error ? error.message : String(error),
				attemptId,
				deliveryId,
				prNumber: decision.pr.prNumber,
				headSha: decision.pr.headSha,
				checkRunId,
			}),
		);
		await watchdog
			.finish(attemptId, {
				conclusion: "failure",
				summary: "The review could not be admitted. Reapply the `bot:review` label to retry.",
			})
			.catch(() => undefined);
		return c.text("failed to admit review", 502);
	}
	if (!admit.ok) {
		const admissionError = await admit.text();
		console.error(
			JSON.stringify({
				message: "review workflow admission failed",
				status: admit.status,
				error: admissionError,
				attemptId,
				deliveryId,
				prNumber: decision.pr.prNumber,
				headSha: decision.pr.headSha,
				checkRunId,
			}),
		);
		await watchdog
			.finish(attemptId, {
				conclusion: "failure",
				summary: "The review could not be admitted. Reapply the `bot:review` label to retry.",
			})
			.catch((error) => {
				console.error(
					JSON.stringify({
						message: "review admission failure check update failed",
						error: error instanceof Error ? error.message : String(error),
						attemptId,
						checkRunId,
					}),
				);
			});
		return c.text("failed to admit review", 502);
	}

	let admission: { runId?: string } = {};
	try {
		admission = await admit.json<{ runId?: string }>();
	} catch {
		// The workflow is already admitted; report the missing correlation below.
	}
	const runId = admission.runId;
	if (!runId) {
		console.error(
			JSON.stringify({
				message: "review workflow admission returned no run id",
				attemptId,
				deliveryId,
				prNumber: decision.pr.prNumber,
				checkRunId,
			}),
		);
	} else {
		await watchdog.identify(attemptId, runId).catch((error) => {
			console.error(
				JSON.stringify({
					message: "review watchdog correlation failed",
					error: error instanceof Error ? error.message : String(error),
					attemptId,
					runId,
					checkRunId,
				}),
			);
		});
	}

	console.log(
		JSON.stringify({
			message: "review workflow admitted",
			attemptId,
			runId,
			deliveryId,
			prNumber: decision.pr.prNumber,
			headSha: decision.pr.headSha,
			checkRunId,
		}),
	);
	return c.json(
		{ message: `review queued for PR #${decision.pr.prNumber}`, attemptId, runId },
		202,
	);
});

export default app;
