import node from "@astrojs/node";
import react from "@astrojs/react";
import { apiTestPlugin } from "@emdash-cms/plugin-api-test";
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
import { embedsPlugin } from "@emdash-cms/plugin-embeds";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
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
				// Settings (retention, data changes, excluded collections) are
				// configured at runtime via the admin UI, not constructor options.
				auditLogPlugin(),

				// 2. Webhook notifier sends events to external URLs
				// Demonstrates: network:fetch:any, apiRoutes, settings.secret(),
				//               hook dependencies, errorPolicy: "continue"
				// Webhook URL, collections, and actions are configured via admin settings.
				webhookNotifierPlugin(),

				// 3. Embeds plugin for YouTube, Vimeo, Twitter, etc.
				// Components are auto-registered with PortableText
				embedsPlugin(),

				// 4. API Test plugin - exercises all v2 APIs
				apiTestPlugin(),
			],
		}),
	],
});
