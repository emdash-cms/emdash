// src/index.ts — descriptor factory, runs in Vite at build time
// Imported in astro.config.mjs — must be side-effect-free.
import type { PluginDescriptor } from "emdash";

export function emailOnPublishPlugin(): PluginDescriptor {
	return {
		id: "email-on-publish",
		version: "1.0.0",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-email-on-publish/sandbox",
		options: {},
	};
}
