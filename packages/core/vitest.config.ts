import { defineConfig } from "vitest/config";

// Stub the adapter-provided virtual modules that runtime code imports.
// Individual tests still `vi.mock()` the ones they care about; this plugin
// just prevents "cannot find package" errors when a test pulls in a chunk
// of core that happens to touch one transitively. Mirrors the pattern the
// Astro integration's vite plugin uses at build time.
const virtualStubs: Record<string, string> = {
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
	// No timer heartbeat under test — like the Cloudflare adapter's output.
	"virtual:emdash/scheduler": "export const createScheduler = null;",
	// Default-export an empty config so modules that read top-level fields
	// (e.g. `virtualConfig?.i18n?.defaultLocale`) don't blow up on import.
	// Tests that need real config still `vi.mock(...)` their own.
	"virtual:emdash/config": "export default {};",
	// No Cloudflare bindings under test — like a Node build. Callers fall
	// back to `import.meta.env`.
	"virtual:emdash/env": "export const env = undefined;",
};

export default defineConfig({
	plugins: [
		{
			name: "emdash-virtual-stubs",
			resolveId(id) {
				// Object.hasOwn — not `in` — so prototype-chain properties
				// (toString, hasOwnProperty, etc.) aren't accidentally matched.
				if (Object.hasOwn(virtualStubs, id)) return "\0" + id;
				return null;
			},
			load(id) {
				if (!id.startsWith("\0virtual:emdash/")) return null;
				const key = id.slice(1);
				if (Object.hasOwn(virtualStubs, key)) return virtualStubs[key];
				return null;
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
			// Render tests import .astro components and need the Astro Vite
			// plugin -- run them via the dedicated repro config (test:repro),
			// not this plain-node config which cannot transform .astro.
			"tests/repro/**/*.render.test.ts",
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
