import node from "@astrojs/node";
import react from "@astrojs/react";
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react({
			babel: {
				plugins: ["@lingui/babel-plugin-lingui-macro"],
			},
		}),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
			plugins: [auditLogPlugin()],
		}),
	],
	devToolbar: { enabled: false },
	vite: {
		plugins: [lingui()],
	},
});
