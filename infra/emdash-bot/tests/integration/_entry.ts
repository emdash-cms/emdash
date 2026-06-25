// Worker entry consumed only by the workers-pool test runner
// (vitest.workers.config.ts -> wrangler.test.jsonc).
//
// Mounts ONLY the bot's core routes (health, /webhook/github). Skips Flue's
// workflow-invoke routes because wrangler.test.jsonc doesn't declare the
// Flue-generated workflow DOs -- they only exist after `flue build`.
//
// Re-exports the DO classes wrangler.test.jsonc declares so miniflare can
// find their class bindings. Production never imports this file; the prod
// entry is `.flue/app.ts` driven by `flue build`. Keep them aligned manually
// when adding new DOs or core routes.

import { Hono } from "hono";

import { registerCoreRoutes } from "../../.flue/routes.js";

export { Sandbox } from "@cloudflare/sandbox";
export { OrchestratorDO } from "../../.flue/lib/orchestrator.js";

const app = registerCoreRoutes(new Hono<{ Bindings: Env }>());

export default {
	fetch: app.fetch.bind(app),
} satisfies ExportedHandler<Env>;
