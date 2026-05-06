/**
 * Sandboxed Test Plugin for EmDash CMS
 *
 * Tests the sandboxed plugin system. Designed to run in an isolated
 * V8 isolate via Worker Loader. Admin UI uses Block Kit.
 */

import type { PluginDescriptor } from "emdash";

import { version } from "../package.json";

/**
 * Plugin factory - returns a descriptor for the integration
 */
export function sandboxedTestPlugin(): PluginDescriptor {
	return {
		id: "sandboxed-test",
		version,
		format: "standard",
		entrypoint: "@emdash-cms/plugin-sandboxed-test/sandbox",

		adminPages: [{ path: "/sandbox", label: "Sandbox Tests", icon: "shield" }],
		adminWidgets: [{ id: "sandbox-status", title: "Sandbox Status", size: "half" }],

		capabilities: ["content:read", "network:request"],
		allowedHosts: ["httpbin.org"],
		storage: {
			events: { indexes: ["timestamp", "type"] },
		},
	};
}
