import { defineConfig } from "vitest/config";

export default defineConfig({
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
