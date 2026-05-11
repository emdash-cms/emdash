/**
 * Marketplace Test Plugin for EmDash CMS
 *
 * A self-contained plugin designed for end-to-end testing of the marketplace
 * publish → audit → approval pipeline. Includes:
 * - Backend sandbox code (content:beforeSave hook)
 * - Icon and screenshot assets
 * - Full manifest with capabilities
 *
 * Usage:
 *   emdash plugin bundle --dir packages/plugins/marketplace-test
 *   emdash plugin publish dist/marketplace-test-0.1.0.tar.gz --registry <url>
 */

import type { PluginDescriptor } from "emdash";

import { version } from "../package.json";

/**
 * Plugin factory -- returns a descriptor for the integration.
 */
export function marketplaceTestPlugin(): PluginDescriptor {
	return {
		id: "marketplace-test",
		version,
		format: "standard",
		entrypoint: "@emdash-cms/plugin-marketplace-test/sandbox",
		capabilities: ["content:read", "content:write"],
		allowedHosts: [],
		storage: {
			events: { indexes: ["timestamp", "type"] },
		},
	};
}

export default marketplaceTestPlugin;
