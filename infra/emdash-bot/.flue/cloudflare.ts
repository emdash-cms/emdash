// Cloudflare-target Durable Object exports.
//
// `flue add sandbox cloudflare` expects to re-export the Sandbox DO from this
// module so wrangler.jsonc's class_name reference resolves. Flue's own
// FlueRegistry DO is bundled by `flue build --target cloudflare` automatically;
// we don't re-export it here.
import type { Sandbox as SandboxClass } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

// `wrangler types` generates `Env.Sandbox: DurableObjectNamespace<undefined>`
// because it can't infer the bound class from wrangler.jsonc. Narrow it here
// so `getSandbox(env.Sandbox, id)` typechecks against its generic constraint
// (`T extends Sandbox<any>`).
declare global {
	interface Env {
		Sandbox: DurableObjectNamespace<SandboxClass>;
	}
}
