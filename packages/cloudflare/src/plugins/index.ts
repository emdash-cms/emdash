/**
 * Cloudflare Plugins
 *
 * Optional plugins that enhance EmDash with Cloudflare-specific features.
 */

export { vectorizeSearch, type VectorizeSearchConfig } from "./vectorize-search.js";
export {
	cloudflareEmail,
	createCloudflareEmailDeliver,
	type CloudflareEmailConfig,
} from "./cloudflare-email.js";
