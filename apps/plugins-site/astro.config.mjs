import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import { defineConfig, fontProviders } from "astro/config";

export default defineConfig({
	site: "https://plugins.emdashcms.com",
	output: "server",
	adapter: cloudflare({ imageService: "passthrough" }),
	cache: { provider: cacheCloudflare() },
	session: false,
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-sans",
			weights: [400, 500, 600, 700],
			fallbacks: ["Arial", "sans-serif"],
		},
	],
	devToolbar: { enabled: false },
});
