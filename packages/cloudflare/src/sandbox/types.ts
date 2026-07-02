/**
 * Cloudflare-specific types for sandbox runner
 */

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

/**
 * Environment bindings required for sandbox runner.
 * These must be configured in wrangler.jsonc.
 */
export interface CloudflareSandboxEnv {
	/** Worker Loader binding for spawning plugin isolates */
	LOADER?: WorkerLoader;
	/** D1 database for plugin storage and bridge operations */
	DB: D1Database;
	/** R2 bucket for plugin code storage (optional if loading from config) */
	PLUGINS?: R2Bucket;
}

/**
 * Worker Loader binding type.
 * This is the API provided by Cloudflare's Worker Loader feature.
 */
export interface WorkerLoader {
	/**
	 * Get or create a dynamic worker instance.
	 *
	 * @param name - Unique identifier for this worker instance
	 * @param config - Configuration function returning worker setup
	 * @returns A stub to interact with the dynamic worker
	 */
	get(name: string, config: () => WorkerLoaderConfig | Promise<WorkerLoaderConfig>): WorkerStub;
}

/**
 * Configuration for a dynamically loaded worker.
 */
export interface WorkerLoaderConfig {
	/** Compatibility date for the worker */
	compatibilityDate?: string;
	/** Name of the main module (must be in modules) */
	mainModule: string;
	/** Map of module names to their code */
	modules: Record<string, string | { js: string }>;
	/** Environment bindings to pass to the worker */
	env?: Record<string, unknown>;
	/**
	 * Outbound fetch handler.
	 * Set to null to block all network access.
	 * Set to a service binding to intercept/proxy requests.
	 */
	globalOutbound?: null | object;
	/**
	 * Resource limits enforced at the V8 isolate level.
	 * Analogous to Workers for Platforms custom limits.
	 */
	limits?: WorkerLoaderLimits;
}

/**
 * Resource limits for a dynamically loaded worker.
 * Enforced by the Worker Loader runtime at the V8 isolate level.
 */
export interface WorkerLoaderLimits {
	/** Maximum CPU time in milliseconds per invocation */
	cpuMs?: number;
	/** Maximum number of subrequests (fetch/service-binding calls) per invocation */
	subRequests?: number;
}

/**
 * Stub returned by Worker Loader for interacting with dynamic workers.
 */
export interface WorkerStub {
	/**
	 * Get the default entrypoint (fetch handler).
	 */
	fetch(request: Request): Promise<Response>;

	/**
	 * Get a named entrypoint class instance for RPC.
	 */
	getEntrypoint<T = unknown>(name?: string): T;
}

/**
 * Plugin manifest - loaded from manifest.json in plugin bundle.
 */
export interface LoadedPluginManifest {
	id: string;
	version: string;
	capabilities: string[];
	allowedHosts: string[];
	storage: Record<string, { indexes: Array<string | string[]> }>;
	hooks: string[];
	routes: string[];
}

/**
 * Content item shape returned by bridge content operations.
 * Matches core's ContentItem from plugins/types.ts.
 */
interface BridgeContentItem {
	id: string;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/**
 * Taxonomy definition shape returned by bridge taxonomy operations.
 * Matches core's TaxonomyDefInfo from plugins/types.ts.
 */
interface BridgeTaxonomyDef {
	name: string;
	label: string;
	labelSingular: string | null;
	hierarchical: boolean;
	collections: string[];
	locale: string;
}

/**
 * Taxonomy term shape returned by bridge taxonomy operations.
 * Matches core's TaxonomyTermInfo from plugins/types.ts.
 */
interface BridgeTaxonomyTerm {
	id: string;
	taxonomy: string;
	slug: string;
	label: string;
	parentId: string | null;
	data: Record<string, unknown> | null;
	locale: string;
	translationGroup: string | null;
}

/**
 * Media item shape returned by bridge media operations.
 * Matches core's MediaItem from plugins/types.ts.
 */
interface BridgeMediaItem {
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	url: string;
	createdAt: string;
}

/**
 * Type for the PluginBridge binding passed to sandboxed workers.
 * This is the RPC interface exposed by PluginBridge WorkerEntrypoint.
 */
export interface PluginBridgeBinding {
	// KV
	kvGet(key: string): Promise<unknown>;
	kvSet(key: string, value: unknown): Promise<void>;
	kvDelete(key: string): Promise<boolean>;
	kvList(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
	// Storage
	storageGet(collection: string, id: string): Promise<unknown>;
	storagePut(collection: string, id: string, data: unknown): Promise<void>;
	storageDelete(collection: string, id: string): Promise<boolean>;
	storageQuery(
		collection: string,
		opts?: { limit?: number; cursor?: string },
	): Promise<{ items: Array<{ id: string; data: unknown }>; hasMore: boolean; cursor?: string }>;
	storageCount(collection: string): Promise<number>;
	storageGetMany(collection: string, ids: string[]): Promise<Map<string, unknown>>;
	storagePutMany(collection: string, items: Array<{ id: string; data: unknown }>): Promise<void>;
	storageDeleteMany(collection: string, ids: string[]): Promise<number>;
	// Content
	contentGet(collection: string, id: string): Promise<BridgeContentItem | null>;
	contentList(
		collection: string,
		opts?: { limit?: number; cursor?: string },
	): Promise<{ items: BridgeContentItem[]; cursor?: string; hasMore: boolean }>;
	contentCreate(collection: string, data: Record<string, unknown>): Promise<BridgeContentItem>;
	contentUpdate(
		collection: string,
		id: string,
		data: Record<string, unknown>,
	): Promise<BridgeContentItem>;
	contentDelete(collection: string, id: string): Promise<boolean>;
	// Taxonomies (read-only, gated on content:read)
	taxonomyList(opts?: { locale?: string }): Promise<BridgeTaxonomyDef[]>;
	taxonomyTerms(taxonomy: string, opts?: { locale?: string }): Promise<BridgeTaxonomyTerm[]>;
	taxonomyEntryTerms(
		collection: string,
		entryId: string,
		opts?: { taxonomy?: string; locale?: string },
	): Promise<BridgeTaxonomyTerm[]>;
	// Media
	mediaGet(id: string): Promise<BridgeMediaItem | null>;
	mediaList(opts?: {
		limit?: number;
		cursor?: string;
		mimeType?: string;
	}): Promise<{ items: BridgeMediaItem[]; cursor?: string; hasMore: boolean }>;
	mediaUpload(
		filename: string,
		contentType: string,
		bytes: ArrayBuffer,
	): Promise<{ mediaId: string; storageKey: string; url: string }>;
	mediaDelete(id: string): Promise<boolean>;
	// Network
	httpFetch(
		url: string,
		init?: RequestInit,
	): Promise<{ status: number; headers: Record<string, string>; text: string }>;
	// Email
	emailSend(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
	// Logging
	log(level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown): void;
}
