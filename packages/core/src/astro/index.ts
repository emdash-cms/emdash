/**
 * emdash/astro
 *
 * Astro integration for EmDash CMS (build-time only)
 *
 * For runtime APIs (loader, query functions, dialects), import from "emdash" directly.
 * For Cloudflare-specific adapters (d1, r2, access), import from "@emdash-cms/cloudflare".
 */

// Locals types (for typing Astro.locals in API routes)
export type {
	EmDashHandlers,
	EmDashManifest,
	MediaItem,
	ContentItem,
	ManifestCollection,
} from "./types.js";

// Storage adapters (for integration config)
// Note: For R2 bindings, use `r2()` from `@emdash-cms/cloudflare`
export { local, s3 } from "./storage/index.js";
export type { StorageDescriptor, LocalStorageConfig, S3StorageConfig } from "./storage/index.js";

// Object cache adapters (for integration config)
// Note: For Cloudflare KV, use `kvCache()` from `@emdash-cms/cloudflare`
export { memoryCache } from "./object-cache/adapters.js";
export type { MemoryCacheOptions } from "./object-cache/adapters.js";
export type { ObjectCacheDescriptor, ObjectCacheRuntimeConfig } from "../object-cache/types.js";

// Integration (build-time only - the emdash() function uses Node.js APIs)
export { default } from "./integration/index.js";
export { getStoredConfig } from "./integration/runtime.js";
export type { EmDashConfig, ResolvedPlugin } from "./integration/runtime.js";
