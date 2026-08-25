// Core bot routes (dashboard, health, /webhook/github). Separated from app.ts so the
// workers-pool test entry can mount them without pulling in Flue's
// workflow-invoke routes (which require workflow DOs that aren't declared in
// wrangler.test.jsonc).

import type { Hono } from "hono";

import dashboardHtml from "./dashboard.html?raw";
import { getDashboardPayload } from "./lib/dashboard.js";
import {
	getPullRequestHeadBranch,
	mintInstallationToken,
	readAppCreds,
	readRepoContext,
} from "./lib/github.js";
import type { OrchestratorDO } from "./lib/orchestrator.js";
import {
	normalizeWebhook,
	resolvePullRequestWebhook,
	verifyWebhookSignature,
} from "./lib/webhook.js";

interface TraceRouteEnv extends Env {
	Orchestrator: DurableObjectNamespace<OrchestratorDO>;
}

const WEBHOOK_GITHUB_LOOKUP_TIMEOUT_MS = 8_000;

export function registerCoreRoutes(app: Hono<{ Bindings: Env }>): Hono<{ Bindings: Env }> {
	app.get("/", (c) => c.html(dashboardHtml));
	app.get("/health", (c) => c.text("ok"));
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
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Wrangler cannot infer local DO RPC methods.
			const { Orchestrator } = c.env as TraceRouteEnv;
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

		let result = normalizeWebhook({ eventType, deliveryId, payload });
		if (result.kind === "pong") {
			console.log("[webhook] ping", { delivery: deliveryId });
			return c.text("pong", 200);
		}
		// issue_comment payloads identify a PR but omit its head ref, which is
		// the trusted link back to the originating issue lifecycle.
		if (result.kind === "pull_request") {
			const unresolved = result;
			const creds = readAppCreds(c.env);
			const repo = readRepoContext(c.env);
			if (!creds || !repo) return c.text("GitHub integration not configured", 503);
			try {
				const signal = AbortSignal.timeout(WEBHOOK_GITHUB_LOOKUP_TIMEOUT_MS);
				const token = await mintInstallationToken(creds, signal);
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
