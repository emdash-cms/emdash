import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const virtualStubs: Record<string, string> = {
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
	"virtual:emdash/scheduler": "export const createScheduler = null;",
	"virtual:emdash/rooms": "export const createRoomHost = null;",
	"virtual:emdash/room-engine":
		'export const loadRoomEngine = () => import("emdash/internal/co-editing/room");',
	"virtual:emdash/config": "export default {};",
	"virtual:emdash/env": "export const env = undefined;",
	"virtual:emdash/object-cache":
		"export const createObjectCache = undefined; export const objectCacheConfig = {};",
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
		cloudflareTest({
			main: "./tests/workerd/fixtures/plugin-storage-worker.ts",
			miniflare: {
				workerLoaders: { LOADER: {} },
				compatibilityDate: "2026-05-14",
				compatibilityFlags: ["nodejs_compat"],
				d1Databases: ["DB", "TARGET_DB"],
				r2Buckets: ["MEDIA"],
				// Without `useSQLite`, the object gets key-value storage with no `storage.sql`.
				durableObjects: { EMDASH_ROOMS: { className: "EmDashRoom", useSQLite: true } },
			},
		}),
	],
	test: {
		include: ["tests/workerd/**/*.test.ts"],
		globalSetup: ["./tests/workerd/global-setup/sqlite-package.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
