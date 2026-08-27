import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const virtualStubs: Record<string, string> = {
	"virtual:emdash/build": "export const buildTime = 0;",
	"virtual:emdash/config": "export default {};",
	"virtual:emdash/env": "export const env = undefined;",
	"virtual:emdash/object-cache":
		"export const createObjectCache = undefined; export const objectCacheConfig = {};",
	"virtual:emdash/scheduler": "export const createScheduler = null;",
	"virtual:emdash/seed": 'export const seed = { version: "1" }; export const userSeed = null;',
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
};

export default defineConfig({
	plugins: [
		{
			name: "emdash-virtual-stubs",
			resolveId(id) {
				if (Object.hasOwn(virtualStubs, id)) return `\0${id}`;
				return null;
			},
			load(id) {
				if (!id.startsWith("\0virtual:emdash/")) return null;
				return virtualStubs[id.slice(1)] ?? null;
			},
		},
		cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
	],
	test: {
		include: ["tests/workerd/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
