/**
 * Workers-pool test config.
 *
 * Runs tests under tests/integration/ inside a real workerd isolate via
 * `@cloudflare/vitest-pool-workers`. Bindings (Sandbox, OrchestratorDO, AI, R2,
 * KV-equivalent DO storage) come from wrangler.jsonc -- the same config dev and
 * prod read -- so tests exercise the same shapes as the deployed Worker.
 *
 * Why two configs: pure unit tests (tests/unit/) run in milliseconds on a plain
 * Node + vitest pool. Anything touching bindings (DOs, AI, Sandbox) needs the
 * workers pool, which is heavier but mandatory for correctness -- mocking
 * `DurableObjectState` would let bugs through that production catches.
 *
 * Bindings the test pool overrides vs production:
 *   - GITHUB_APP_PRIVATE_KEY: a stub PEM the tests never actually use for
 *     real signing. Real auth integration goes through fakes injected at
 *     call sites.
 *   - GITHUB_WEBHOOK_SECRET: stub secret for HMAC verification tests.
 *
 * Real AI binding calls cost tokens. Tests that need the AI shape should mock
 * `env.AI` via the test pool's fake binding feature; eval-grade runs against
 * real Workers AI live in a separate suite.
 */

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			miniflare: {
				bindings: {
					GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
					// Empty key so readAppCreds returns null in tests and the
					// orchestrator's side-effect path no-ops without hitting
					// api.github.com. Tests that need a real key inject it via
					// `env.GITHUB_APP_PRIVATE_KEY = ...` inside the test.
					GITHUB_APP_PRIVATE_KEY: "",
				},
			},
		}),
	],
	test: {
		include: ["tests/integration/**/*.test.ts"],
	},
});
