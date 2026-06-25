// Cloudflare-target Durable Object exports.
//
// `flue add sandbox cloudflare` expects to re-export the Sandbox DO from this
// module so wrangler.jsonc's class_name reference resolves. Flue's own
// FlueRegistry DO is bundled by `flue build --target cloudflare` automatically;
// we don't re-export it here.
import type { Sandbox as SandboxClass } from "@cloudflare/sandbox";

import type { OrchestratorDO as OrchestratorDOClass } from "./lib/orchestrator.js";

export { Sandbox } from "@cloudflare/sandbox";
export { OrchestratorDO } from "./lib/orchestrator.js";

// `wrangler types` generates DurableObjectNamespace<undefined> for both bindings
// because it can't infer the bound class from wrangler.jsonc. Narrow them here
// so call sites typecheck against their generic constraints.
declare global {
	interface Env {
		Sandbox: DurableObjectNamespace<SandboxClass>;
		Orchestrator: DurableObjectNamespace<OrchestratorDOClass>;
	}
}
