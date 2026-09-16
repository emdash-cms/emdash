import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { emdashPluginTest } from "./src/config.js";

const fixture = fileURLToPath(new URL("./test/fixture", import.meta.url));
const virtualStubs: Record<string, string> = {
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
	"virtual:emdash/scheduler": "export const createScheduler = null;",
	"virtual:emdash/config": "export default {};",
	"virtual:emdash/env": "export const env = undefined;",
	"virtual:emdash/build": "export const buildTime = 0;",
	"virtual:emdash/object-cache": "export const createObjectCacheBackend = null;",
};

export default defineConfig({
	plugins: [
		{
			name: "emdash-runtime-virtual-stubs",
			resolveId(id) {
				if (Object.hasOwn(virtualStubs, id)) return `\0${id}`;
				return null;
			},
			load(id) {
				if (!id.startsWith("\0virtual:emdash/")) return null;
				return virtualStubs[id.slice(1)] ?? null;
			},
		},
		emdashPluginTest({ dir: fixture }),
	],
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
