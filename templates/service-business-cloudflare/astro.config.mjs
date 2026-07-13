import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1 } from "@emdash-cms/cloudflare";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare({ imageService: "passthrough" }),
	image: { layout: "constrained", responsiveStyles: true },
	integrations: [react(), emdash({ database: d1({ binding: "DB", session: "auto" }) })],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Manrope",
			cssVariable: "--font-heading",
			weights: [500, 600, 700, 800],
			fallbacks: ["sans-serif"],
		},
	],
	devToolbar: { enabled: false },
});
