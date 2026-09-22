import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { playgroundDatabase } from "@emdash-cms/cloudflare";
import { defineConfig, fontProviders } from "astro/config";
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
			storage: {
				entrypoint: "@emdash-cms/cloudflare/db/playground",
				config: {},
			},
			mcp: false,
			// Playground mode: injects playground middleware before runtime init,
			// skips setup/auth (handled by playground middleware)
			playground: {
				middlewareEntrypoint: "@emdash-cms/cloudflare/db/playground-middleware",
			},
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-sans",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
