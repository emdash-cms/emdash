import { defineConfig } from "vitest/config";

/**
 * Standalone calibration runner config (plan W8.6). Runs the `*.calibrate.ts`
 * entrypoints in a plain Node environment with real network access — NOT the
 * workerd pool the deterministic suite uses, and NOT referenced by
 * `pnpm test`. Select an entry with a positional filter, e.g.
 * `vitest run --config calibration/vitest.config.ts run.calibrate`.
 */
export default defineConfig({
	root: import.meta.dirname,
	test: {
		include: ["*.calibrate.ts"],
		// The full matrix is ~48 real model calls; the slow reasoning model alone
		// spends ~20 min, so the whole sweep runs ~30-40 min. Generous headroom so
		// a slow API day doesn't truncate the run (the runner also writes the
		// manifest incrementally, so a truncated run is still reportable).
		testTimeout: 5_400_000,
		hookTimeout: 120_000,
		pool: "forks",
	},
});
