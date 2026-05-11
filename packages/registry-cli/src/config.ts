/**
 * Shared config for the registry CLI.
 *
 * The aggregator URL defaults to the experimental host but can be overridden
 * per-invocation via `--aggregator <url>` or by the `EMDASH_REGISTRY_URL`
 * env var. We resolve in that order, falling back to the default.
 *
 * EXPERIMENTAL: the default host is provisional. It will be retired and
 * replaced at phase 1 cutover; pin the override flag if you depend on a
 * specific aggregator.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Default aggregator URL during the experimental phase. The exact host is TBD;
 * this constant is the single place to update once we deploy the first
 * aggregator. See `.opencode/plans/plugin-registry-implementation.md`
 * § "Open questions".
 */
export const DEFAULT_AGGREGATOR_URL = "https://experimental-registry.emdashcms.com";

/**
 * Default directory for OAuth state (sessions, in-flight authorize states).
 * Co-located with the credentials store from `@emdash-cms/registry-client` so
 * users have one place to clean up if they want to wipe registry credentials.
 */
export const DEFAULT_OAUTH_DIR = join(homedir(), ".emdash", "oauth");

/**
 * Resolves the aggregator URL for the current invocation.
 *
 * Precedence: explicit flag > env var > default.
 */
export function resolveAggregatorUrl(flag?: string): string {
	if (flag && flag.length > 0) return flag;
	const fromEnv = process.env["EMDASH_REGISTRY_URL"];
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return DEFAULT_AGGREGATOR_URL;
}
