import { createSiteInfo, type SiteInfoOptions } from "../context.js";
import type { SandboxOptions } from "./types.js";

/**
 * Build platform sandbox options with the same normalized site context used
 * by trusted plugin hooks and routes.
 */
export function createSandboxRunnerOptions(
	options: Omit<SandboxOptions, "siteInfo">,
	siteInfo?: SiteInfoOptions,
): SandboxOptions {
	return {
		...options,
		siteInfo: createSiteInfo(siteInfo ?? {}),
	};
}
