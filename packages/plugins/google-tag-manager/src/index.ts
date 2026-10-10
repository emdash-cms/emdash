import type { PluginDescriptor } from "emdash";

export function googleTagManagerPlugin(): PluginDescriptor {
	return {
		id: "google-tag-manager",
		version: "0.1.0",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-google-tag-manager/sandbox",
		options: {},
		capabilities: ["page:inject"],
		adminPages: [{ path: "/settings", label: "Google Tag Manager", icon: "activity" }],
	};
}
