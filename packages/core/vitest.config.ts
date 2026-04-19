import { defineConfig } from "vitest/config";

// Stub the adapter-provided virtual modules that runtime code imports.
// Individual tests still `vi.mock()` the ones they care about; this plugin
// just prevents "cannot find package" errors when a test pulls in a chunk
// of core that happens to touch one transitively. Mirrors the pattern the
// Astro integration's vite plugin uses at build time.
const virtualStubs = {
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
};

export default defineConfig({
	plugins: [
		{
			name: "emdash-virtual-stubs",
			resolveId(id) {
				if (id in virtualStubs) return "\0" + id;
			},
			load(id) {
				if (id.startsWith("\0virtual:emdash/")) {
					const key = id.slice(1) as keyof typeof virtualStubs;
					return virtualStubs[key];
				}
			},
		},
	],
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Server integration tests (cli, client, smoke) start real Astro dev
		// servers and need a full workspace build — run them in a dedicated
		// CI job, not via `pnpm test`.
		// The fixture has symlinked node_modules that contain test files
		// from transitive deps (zod, emdash) — exclude them too.
		exclude: [
			"tests/integration/smoke/**",
			"tests/integration/cli/**",
			"tests/integration/client/**",
			"tests/integration/media/**",
			"tests/integration/fixture/**",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			thresholds: {
				statements: 80,
				branches: 80,
				functions: 80,
				lines: 80,
			},
		},
	},
});
