// Worker entry consumed only by the workers-pool test runner
// (vitest.workers.config.ts -> wrangler.test.jsonc).
//
// Re-exports the DO classes wrangler.test.jsonc declares so miniflare can find
// their class bindings. The default `fetch` handler is intentionally minimal --
// tests dispatch directly to DO stubs via `env.Orchestrator.getByName(...)`
// rather than going through HTTP, so this handler exists mostly so SELF.fetch
// stays valid (some test patterns rely on it).
//
// Production never imports this file; the prod entry is `.flue/app.ts` driven
// by `flue build`. Keep them aligned manually when adding new DOs.

export { Sandbox } from "@cloudflare/sandbox";
export { OrchestratorDO } from "../../.flue/lib/orchestrator.js";

export default {
	async fetch(): Promise<Response> {
		return new Response("test entry: dispatch to DOs via env, not HTTP", {
			status: 200,
		});
	},
} satisfies ExportedHandler<Env>;
