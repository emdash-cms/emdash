import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { playgroundDatabase } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			// Playground uses a DO-backed database, not D1
			database: playgroundDatabase({ binding: "PLAYGROUND_DB" }),
			// No storage -- media uploads are blocked in playground mode
			// Playground mode: injects playground middleware before runtime init,
			// skips setup/auth (handled by playground middleware)
			playground: {
				middlewareEntrypoint: "@emdash-cms/cloudflare/db/playground-middleware",
			},
		}),
	],
	devToolbar: { enabled: false },
});
