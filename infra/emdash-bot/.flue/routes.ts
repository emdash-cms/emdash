// Core bot routes (health, /webhook/github). Separated from app.ts so the
// workers-pool test entry can mount them without pulling in Flue's
// workflow-invoke routes (which require workflow DOs that aren't declared in
// wrangler.test.jsonc).

import type { Hono } from "hono";

import { normalizeWebhook, verifyWebhookSignature } from "./lib/webhook.js";

export function registerCoreRoutes(app: Hono<{ Bindings: Env }>): Hono<{ Bindings: Env }> {
	app.get("/health", (c) => c.text("ok"));

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

		const result = normalizeWebhook({ eventType, deliveryId, payload });
		if (result.kind === "pong") {
			console.log("[webhook] ping", { delivery: deliveryId });
			return c.text("pong", 200);
		}
		if (result.kind === "skip") {
			console.log("[webhook] skip", {
				event: eventType,
				delivery: deliveryId,
				reason: result.reason,
			});
			return c.text(`skipped: ${result.reason}`, 202);
		}

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
