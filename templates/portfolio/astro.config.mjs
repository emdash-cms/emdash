import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { Features } from "lightningcss";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	vite: {
		css: {
			// Keep light-dark() native so the footer theme switcher works in
			// production. For older browsers, Lightning CSS otherwise rewrites
			// it into variables that follow only prefers-color-scheme, which the
			// :root.light / :root.dark color-scheme rules in Base.astro can't
			// reach. Browsers without light-dark() get the light fallback in
			// tokens.css.
			lightningcss: { exclude: Features.LightDark },
		},
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Playfair Display",
			cssVariable: "--font-heading",
			weights: [400, 500, 600, 700],
			fallbacks: ["serif"],
		},
	],
	devToolbar: { enabled: false },
});
