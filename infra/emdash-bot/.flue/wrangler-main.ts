// `main` entry referenced from wrangler.jsonc so `wrangler types` can populate
// `Cloudflare.Env`'s DO namespaces and `Cloudflare.Exports` with the right
// class generics. `flue dev` ignores this file at runtime and uses its own
// generated entry; the real fetch handler lives in app.ts.

export { Sandbox, OrchestratorDO, ContainerProxy } from "./cloudflare.js";

export default {
	async fetch(): Promise<Response> {
		return new Response("flue dev manages the real entry; this is a type-only stub", {
			status: 500,
		});
	},
} satisfies ExportedHandler<Env>;
