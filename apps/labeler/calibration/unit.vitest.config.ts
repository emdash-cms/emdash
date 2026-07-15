import { defineConfig } from "vitest/config";

/**
 * Calibration UNIT tests (plan W8.6). Plain Node environment — the harness is
 * Node tooling (it reads fixtures and writes run artifacts via `node:fs`), so
 * its tests don't belong in the workerd pool the labeler suite uses. Runs in
 * `pnpm test`; deterministic, no network (`*.calibrate.ts` sweep entrypoints
 * are excluded — those hit real models and run via `vitest.config.ts`).
 */
export default defineConfig({
	root: import.meta.dirname,
	test: {
		include: ["*.test.ts"],
	},
});
