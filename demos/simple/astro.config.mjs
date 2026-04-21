import node from "@astrojs/node";
import react from "@astrojs/react";
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { slackPlugin } from "emdash-plugin-slack";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	// Example: allowed domains for reverse proxy
	// security: {
	// 	allowedDomains: [
	// 		{ hostname: "emdash.local", protocol: "http" },
	// 		{ hostname: "emdash.local", protocol: "https" },
	// 	],
	// },
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
			plugins: [auditLogPlugin(), slackPlugin()],
			// HTTPS reverse proxy: uncomment so all origin-dependent features match browser
			// siteUrl: "https://emdash.local:8443",
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
	// Example: allowed hosts for reverse proxy
	// vite: {
	// 	server: {
	// 		allowedHosts: ["emdash.local"],
	// 	},
	// },
});
