import node from "@astrojs/node";
import react from "@astrojs/react";
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	i18n: {
		defaultLocale: "en",
		locales: ["en", "pt-br"],
		fallback: {
			"pt-br": "en",
		},
	},
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
			plugins: [auditLogPlugin()],
			// HTTPS reverse proxy: uncomment so passkey verify matches browser origin
			// passkeyPublicOrigin: "https://emdash.local:8443",
		}),
	],
	devToolbar: { enabled: false },
	// Example: allowed hosts for reverse proxy
	// vite: {
	// 	server: {
	// 		allowedHosts: ["emdash.local"],
	// 	},
	// },
});
