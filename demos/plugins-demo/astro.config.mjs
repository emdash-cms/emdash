import node from "@astrojs/node";
import react from "@astrojs/react";
import { apiTestPlugin } from "@emdash-cms/plugin-api-test";
import auditLog from "@emdash-cms/plugin-audit-log";
import { embedsPlugin } from "@emdash-cms/plugin-embeds";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	integrations: [
		react(),
		emdash({
			// SQLite database for demo
			database: sqlite({ url: "file:./data.db" }),

			// Register plugins - order matters for hook execution!
			plugins: [
				// 1. Audit log runs last (priority 200) to capture final state
				auditLog,

				// 2. Webhook notifier sends events to external URLs
				webhookNotifier,

				// 3. Embeds plugin for YouTube, Vimeo, Twitter, etc.
				embedsPlugin(),

				// 4. API Test plugin - exercises all v2 APIs
				apiTestPlugin(),
			],
		}),
	],
});
