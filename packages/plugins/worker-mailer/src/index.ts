import type { PluginDescriptor } from "emdash";

import { PLUGIN_ID, VERSION } from "./shared.js";

/**
 * Standard descriptor for isolated Block Kit configuration and runtime delivery.
 */
export function workerMailerPlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: VERSION,
		format: "standard",
		entrypoint: "@emdash-cms/plugin-worker-mailer/sandbox",
		capabilities: ["email:provide"],
		adminPages: [{ path: "/settings", label: "SMTP", icon: "envelope" }],
	};
}
