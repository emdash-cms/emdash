// Worker entry consumed only by the workers-pool test runner
// (vitest.workers.config.ts -> wrangler.test.jsonc).
//
// Mounts ONLY the bot's core routes (health, /webhook/github). Skips Flue's
// agent routes because wrangler.test.jsonc doesn't declare generated agent
// DOs; those are added by the production Vite build.
//
// Re-exports the DO classes wrangler.test.jsonc declares so miniflare can
// find their class bindings. Production never imports this file; the prod
// entry is `.flue/app.ts` driven by Vite. Keep them aligned manually
// when adding new DOs or core routes.

import { Hono } from "hono";

import { registerCoreRoutes } from "../../.flue/routes.js";

export { Sandbox, ContainerProxy } from "../../.flue/cloudflare.js";
export { OrchestratorDO } from "../../.flue/lib/orchestrator.js";

const app = registerCoreRoutes(new Hono<{ Bindings: Env }>());
app.post("/agents/investigate/:id/abort", (context) =>
	context.json({ aborted: !context.req.param("id").includes("abort-false") }),
);
app.get("/agents/investigate/:id", (context) => {
	const id = context.req.param("id");
	if (id.includes("missing")) return context.json({ error: "not found" }, 404);
	return context.json({ settlements: id.includes("settled") ? [{}] : [] });
});

export default {
	fetch: app.fetch.bind(app),
} satisfies ExportedHandler<Env>;
