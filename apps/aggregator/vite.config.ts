/**
 * Aggregator dev/build via the Cloudflare Vite plugin.
 *
 * The plugin reads `wrangler.jsonc` for bindings (D1, Queues, DOs, vars) and
 * runs the worker inside a workerd-backed Vite dev server. `vite dev` gives
 * us HMR + proper module resolution, `vite build` produces the deployable
 * bundle that `wrangler deploy` ships.
 *
 * Test config is separate: `vitest.config.ts` uses `@cloudflare/vitest-pool-workers`,
 * which manages its own miniflare instance. The two pipelines don't share
 * configuration but read the same `wrangler.jsonc` for binding shape, so the
 * test environment matches dev/prod by construction.
 */

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
});
