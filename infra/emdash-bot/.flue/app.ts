// Worker entry.
//
// Public surface:
//   GET  /health           liveness probe
//   POST /webhook/github   GitHub App webhook ingress (signature-verified)
//   /agents/investigate/*  Authenticated Flue agent control surface
//
// The webhook handler is intentionally thin: it verifies, normalizes, and
// dispatches to the per-issue OrchestratorDO. All long-running work happens
// inside the DO (and the workflows it invokes), not in this handler -- GitHub
// expects an ack within ~10s.
//
// Core routes live in `routes.ts` so the workers-pool test entry can mount
// just those without pulling in Flue's routing.

import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";

import { Investigate } from "./agents/investigate.js";
import { installAgentObserver } from "./lib/observer.js";
import { registerCoreRoutes } from "./routes.js";

installAgentObserver();

const app = new Hono<{ Bindings: Env }>();
registerCoreRoutes(app);

app.use("/agents/*", async (context, next) => {
	const expected = context.env.GITHUB_WEBHOOK_SECRET;
	const provided = context.req.header("authorization") ?? "";
	if (!expected || !(await tokensEqual(provided, `Bearer ${expected}`))) {
		return context.json({ error: "Unauthorized" }, 401);
	}
	await next();
});
app.route("/agents/investigate", createAgentRouter(Investigate));

export default app;

async function tokensEqual(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	if (leftBytes.byteLength !== rightBytes.byteLength) return false;
	return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}
