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

import { verifyWebhookSignature, gatePullRequestEvent } from "./lib/webhook.js";

const flueApp = flue();

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
	const status = c.req.query("status") as "active" | "completed" | "errored" | undefined;
	const result = await listRuns({ limit: 100, ...(status ? { status } : {}) });
	const runs = result.runs ?? [];
	const summary = { active: 0, completed: 0, errored: 0, other: 0 };
	for (const r of runs) {
		if (r.status === "active") summary.active++;
		else if (r.status === "completed") summary.completed++;
		else if (r.status === "errored") summary.errored++;
		else summary.other++;
	}

	// ?detail=1: pull the full RunRecord (payload/result/error) for each run via
	// getRun, to see whether the Cloudflare registry persists those (needed to
	// map a run -> PR and to read the failure reason).
	if (c.req.query("detail") === "1") {
		const detailed = await Promise.all(
			runs.slice(0, 25).map(async (r) => {
				const rec = (await getRun(r.runId).catch(() => null)) as {
					payload?: unknown;
					error?: unknown;
					result?: unknown;
				} | null;
				const payload = rec?.payload as { prNumber?: number } | undefined;
				const err = rec?.error;
				return {
					runId: r.runId,
					status: r.status,
					durationMs: r.durationMs,
					prNumber: payload?.prNumber,
					hasPayload: rec?.payload !== undefined,
					hasResult: rec?.result !== undefined,
					error:
						err === undefined || err === null
							? undefined
							: String((err as { message?: string }).message ?? err).slice(0, 200),
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

	// Admit the durable workflow run (fast). The review + post run in the
	// workflow DO independently of this request. No ?wait=result: we don't
	// block the webhook on the (minutes-long) review.
	const admit = await flueApp.fetch(
		new Request("https://flue.internal/workflows/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(decision.pr),
		}),
		c.env,
		c.executionCtx,
	);
	if (!admit.ok) {
		console.error("[webhook] workflow admission failed:", admit.status, await admit.text());
		return c.text("failed to admit review", 502);
	}

	console.log("[webhook] admitted", { prNumber: decision.pr.prNumber, status: admit.status });
	return c.text(`review queued for PR #${decision.pr.prNumber}`, 202);
});

export default app;
