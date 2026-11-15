import { fileURLToPath } from "node:url";

import node from "@astrojs/node";
import react from "@astrojs/react";
import { emailTemplatesPlugin, resendEmail } from "@emdash-cms/plugin-email-templates";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

const entitiesDecode = fileURLToPath(
	new URL(
		"../../node_modules/.pnpm/entities@6.0.1/node_modules/entities/dist/esm/decode.js",
		import.meta.url,
	),
);

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	vite: {
		optimizeDeps: {
			include: ["@cloudflare/kumo", "@react-email/editor", "@react-email/editor-extensions", "@react-email/editor-plugins", "@react-email/render"],
		},
		resolve: { alias: { "entities/decode": entitiesDecode, "entities/lib/decode.js": entitiesDecode } },
	},
	image: { layout: "constrained", responsiveStyles: true },
	integrations: [
		react(),
		emdash({
			shop: { enabled: true },
			database: sqlite({ url: "file:./data.db" }),
			storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
			plugins: [emailTemplatesPlugin({ enabled: true }), resendEmail()],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "DM Sans",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Playfair Display",
			cssVariable: "--font-display",
			weights: [500, 600, 700],
			fallbacks: ["serif"],
		},
	],
	devToolbar: { enabled: false },
});
