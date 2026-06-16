// Custom Flue application: the GitHub App webhook orchestrator.
//
// This is the ONLY public surface. We deliberately do NOT mount flue() at a
// public path, so the workflow/agent HTTP endpoints are not externally
// reachable; the workflow is admitted only via an internal request from this
// handler. The handler does no long-running work itself (a webhook must ack
// within seconds, and waitUntil caps at 30s): it verifies, gates, admits the
// durable workflow run, and returns. The review and the GitHub post happen
// inside the workflow's Durable Object, which is not bound by that budget.

// @flue/runtime 0.11 removed the `@flue/runtime/app` entry; `createDefaultFlueApp`
// is the replacement factory and still mounts the `/workflows/:name` admission
// route we fetch internally below.
import { createDefaultFlueApp } from "@flue/runtime/internal";
import { Hono } from "hono";

import { verifyWebhookSignature, gatePullRequestEvent } from "./lib/webhook.js";

const flueApp = createDefaultFlueApp();

const app = new Hono<{ Bindings: Env }>();

app.post("/webhook/github", async (c) => {
	const raw = await c.req.text();
	const secret = c.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) return c.text("webhook secret not configured", 500);
	const valid = await verifyWebhookSignature(secret, raw, c.req.header("x-hub-signature-256"));
	if (!valid) return c.text("invalid signature", 401);

	const eventType = c.req.header("x-github-event");
	if (eventType === "ping") return c.text("pong", 200);
	if (eventType !== "pull_request") return c.text(`ignored event: ${eventType}`, 202);

	let event: Parameters<typeof gatePullRequestEvent>[0];
	try {
		event = JSON.parse(raw);
	} catch {
		return c.text("invalid JSON", 400);
	}

	const decision = gatePullRequestEvent(event);
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

	return c.text(`review queued for PR #${decision.pr.prNumber}`, 202);
});

export default app;
