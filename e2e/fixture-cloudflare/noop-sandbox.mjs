/**
 * Noop sandbox runner for e2e tests.
 *
 * The marketplace admin pages only need `marketplace: true` in the manifest
 * to render browse/detail UI. The sandbox runner is only used at install time.
 * This stub satisfies the config validation without importing cloudflare:workers.
 */
import { createNoopSandboxRunner } from "emdash";

export { createNoopSandboxRunner as createSandboxRunner };
