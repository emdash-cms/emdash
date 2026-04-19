/**
 * MarketplaceClient — HTTP client for the EmDash Plugin Marketplace
 *
 * Used by the install/update/proxy endpoints in EmDash core to communicate
 * with the marketplace Worker. The marketplace is a distribution channel,
 * not a runtime dependency — bundles are copied to site-local R2 at install time.
 */

import { createGzipDecoder, unpackTar } from "modern-tar";

import { pluginManifestSchema } from "./manifest-schema.js";
import type { PluginManifest } from "./types.js";

// ── Module-level regex patterns ───────────────────────────────────

const TRAILING_SLASHES = /\/+$/;
const LEADING_DOT_SLASH = /^\.\//;

// ── Types ──────────────────────────────────────────────────────────

export interface MarketplacePluginSummary {
	id: string;
	name: string;
	description: string | null;
	author: {
		name: string;
		verified: boolean;
		avatarUrl: string | null;
	};
	capabilities: string[];
	keywords: string[];
	installCount: number;
	hasIcon: boolean;
	iconUrl: string;
	latestVersion?: {
		version: string;
		audit?: {
			verdict: string;
			riskScore: number;
		};
		imageAudit?: {
			verdict: string;
		};
	};
	createdAt: string;
	updatedAt: string;
}

export interface MarketplaceVersionSummary {
	version: string;
	minEmDashVersion: string | null;
	bundleSize: number;
	checksum: string;
	changelog: string | null;
	capabilities: string[];
	status: string;
	auditVerdict: string | null;
	imageAuditVerdict: string | null;
	publishedAt: string;
}

export interface MarketplacePluginDetail extends MarketplacePluginSummary {
	repositoryUrl: string | null;
	homepageUrl: string | null;
	license: string | null;
	latestVersion?: {
		version: string;
		minEmDashVersion: string | null;
		bundleSize: number;
		checksum: string;
		changelog: string | null;
		readme: string | null;
		hasIcon: boolean;
		screenshotCount: number;
		screenshotUrls: string[];
		capabilities: string[];
		status: string;
		audit?: {
			verdict: string;
			riskScore: number;
		};
		imageAudit?: {
			verdict: string;
		};
		publishedAt: string;
	};
}

export interface MarketplaceSearchOpts {
	category?: string;
	capability?: string;
	sort?: "installs" | "updated" | "created" | "name";
	cursor?: string;
	limit?: number;
}

export interface MarketplaceSearchResult {
	items: MarketplacePluginSummary[];
	nextCursor?: string;
}

export interface MarketplaceCategory {
	id: string;
	slug: string;
	name: string;
	description?: string;
	icon?: string;
}

// ── Theme types ───────────────────────────────────────────────────

export interface MarketplaceThemeSummary {
	id: string;
	name: string;
	description: string | null;
	author: {
		name: string;
		verified: boolean;
		avatarUrl: string | null;
	};
	keywords: string[];
	previewUrl: string;
	demoUrl: string | null;
	hasThumbnail: boolean;
	thumbnailUrl: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MarketplaceThemeDetail extends MarketplaceThemeSummary {
	author: {
		id: string;
		name: string;
		verified: boolean;
		avatarUrl: string | null;
	};
	repositoryUrl: string | null;
	homepageUrl: string | null;
	license: string | null;
	screenshotCount: number;
	screenshotUrls: string[];
}

export interface MarketplaceThemeSearchOpts {
	keyword?: string;
	sort?: "name" | "created" | "updated";
	cursor?: string;
	limit?: number;
}

export interface MarketplaceThemeSearchResult {
	items: MarketplaceThemeSummary[];
	nextCursor?: string;
}

export interface PluginBundle {
	manifest: PluginManifest;
	backendCode: string;
	adminCode?: string;
	checksum: string;
}

// ── Interface ──────────────────────────────────────────────────────

export interface MarketplaceClient {
	/** Search the marketplace catalog */
	search(query?: string, opts?: MarketplaceSearchOpts): Promise<MarketplaceSearchResult>;

	/** Get full plugin detail */
	getPlugin(id: string): Promise<MarketplacePluginDetail>;

	/** Get version history for a plugin */
	getVersions(id: string): Promise<MarketplaceVersionSummary[]>;

	/** Download and extract a plugin bundle */
	downloadBundle(id: string, version: string): Promise<PluginBundle>;

	/** Fire-and-forget install stat (never throws) */
	reportInstall(id: string, version: string): Promise<void>;

	/** List available categories */
	getCategories(): Promise<MarketplaceCategory[]>;

	/** Search theme listings */
	searchThemes(
		query?: string,
		opts?: MarketplaceThemeSearchOpts,
	): Promise<MarketplaceThemeSearchResult>;

	/** Get full theme detail */
	getTheme(id: string): Promise<MarketplaceThemeDetail>;
}

// ── Errors ─────────────────────────────────────────────────────────

export class MarketplaceError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly code?: string,
	) {
		super(message);
		this.name = "MarketplaceError";
	}
}

export class MarketplaceUnavailableError extends MarketplaceError {
	constructor(cause?: unknown) {
		super("Plugin marketplace is unavailable", undefined, "MARKETPLACE_UNAVAILABLE");
		if (cause) this.cause = cause;
	}
}

// ── Implementation ─────────────────────────────────────────────────

class MarketplaceClientImpl implements MarketplaceClient {
	private readonly baseUrl: string;
	private readonly siteOrigin: string | undefined;

	constructor(baseUrl: string, siteOrigin?: string) {
		// Strip trailing slash
		this.baseUrl = baseUrl.replace(TRAILING_SLASHES, "");
		this.siteOrigin = siteOrigin;
	}

	async search(query?: string, opts?: MarketplaceSearchOpts): Promise<MarketplaceSearchResult> {
		const params = new URLSearchParams();
		if (query) params.set("q", query);
		if (opts?.category) params.set("category", opts.category);
		if (opts?.capability) params.set("capability", opts.capability);
		if (opts?.sort) params.set("sort", opts.sort);
		if (opts?.cursor) params.set("cursor", opts.cursor);
		if (opts?.limit) params.set("limit", String(opts.limit));

		const qs = params.toString();
		const url = `${this.baseUrl}/api/v1/plugins${qs ? `?${qs}` : ""}`;
		const data = await this.fetchJson<MarketplaceSearchResult>(url);
		return data;
	}

	async getPlugin(id: string): Promise<MarketplacePluginDetail> {
		const url = `${this.baseUrl}/api/v1/plugins/${encodeURIComponent(id)}`;
		return this.fetchJson<MarketplacePluginDetail>(url);
	}

	async getVersions(id: string): Promise<MarketplaceVersionSummary[]> {
		const url = `${this.baseUrl}/api/v1/plugins/${encodeURIComponent(id)}/versions`;
		const data = await this.fetchJson<{ items: MarketplaceVersionSummary[] }>(url);
		return data.items;
	}

	async downloadBundle(id: string, version: string): Promise<PluginBundle> {
		const bundleUrl = `${this.baseUrl}/api/v1/plugins/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/bundle`;

		const marketplaceOrigin = new URL(this.baseUrl).origin;
		const MAX_REDIRECTS = 5;
		let response: Response;
		try {
			let currentUrl = bundleUrl;
			response = await fetch(currentUrl, { redirect: "manual" });

			// Follow redirects manually, validating each target stays on the marketplace host
			for (let i = 0; i < MAX_REDIRECTS; i++) {
				if (response.status < 300 || response.status >= 400) break;

				const location = response.headers.get("location");
				if (!location) break;

				const target = new URL(location, currentUrl);
				if (target.origin !== marketplaceOrigin) {
					throw new MarketplaceError(
						`Bundle download redirected to untrusted host: ${target.origin}`,
						response.status,
						"BUNDLE_REDIRECT_UNTRUSTED",
					);
				}
				currentUrl = target.href;
				response = await fetch(currentUrl, { redirect: "manual" });
			}

			// If still a redirect after MAX_REDIRECTS, fail explicitly
			if (response.status >= 300 && response.status < 400) {
				throw new MarketplaceError(
					`Bundle download exceeded maximum redirects (${MAX_REDIRECTS})`,
					response.status,
					"BUNDLE_TOO_MANY_REDIRECTS",
				);
			}
		} catch (err) {
			if (err instanceof MarketplaceError) throw err;
			throw new MarketplaceUnavailableError(err);
		}

		if (!response.ok) {
			throw new MarketplaceError(
				`Failed to download bundle: ${response.status} ${response.statusText}`,
				response.status,
				"BUNDLE_DOWNLOAD_FAILED",
			);
		}

		const tarballBytes = new Uint8Array(await response.arrayBuffer());
		try {
			return await extractBundle(tarballBytes);
		} catch (err) {
			if (err instanceof MarketplaceError) throw err;
			throw new MarketplaceError(
				"Failed to extract plugin bundle",
				undefined,
				"BUNDLE_EXTRACT_FAILED",
			);
		}
	}

	async getCategories(): Promise<MarketplaceCategory[]> {
		const url = `${this.baseUrl}/api/v1/categories`;
		const data = await this.fetchJson<{ items: MarketplaceCategory[] }>(url);
		return data.items;
	}

	async reportInstall(id: string, version: string): Promise<void> {
		// Generate a stable site hash from the site origin (best-effort, non-identifying)
		const siteHash = await generateSiteHash(this.siteOrigin);
		const url = `${this.baseUrl}/api/v1/plugins/${encodeURIComponent(id)}/installs`;

		try {
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ siteHash, version }),
			});
		} catch {
			// Fire-and-forget — never throw
		}
	}

	async searchThemes(
		query?: string,
		opts?: MarketplaceThemeSearchOpts,
	): Promise<MarketplaceThemeSearchResult> {
		const params = new URLSearchParams();
		if (query) params.set("q", query);
		if (opts?.keyword) params.set("keyword", opts.keyword);
		if (opts?.sort) params.set("sort", opts.sort);
		if (opts?.cursor) params.set("cursor", opts.cursor);
		if (opts?.limit) params.set("limit", String(opts.limit));

		const qs = params.toString();
		const url = `${this.baseUrl}/api/v1/themes${qs ? `?${qs}` : ""}`;
		return this.fetchJson<MarketplaceThemeSearchResult>(url);
	}

	async getTheme(id: string): Promise<MarketplaceThemeDetail> {
		const url = `${this.baseUrl}/api/v1/themes/${encodeURIComponent(id)}`;
		return this.fetchJson<MarketplaceThemeDetail>(url);
	}

	private async fetchJson<T>(url: string): Promise<T> {
		let response: Response;
		try {
			response = await fetch(url, {
				headers: { Accept: "application/json" },
			});
		} catch (err) {
			throw new MarketplaceUnavailableError(err);
		}

		if (!response.ok) {
			let errorMessage = `Marketplace request failed: ${response.status}`;
			try {
				const body: { error?: string } = await response.json();
				if (body.error) errorMessage = body.error;
			} catch {
				// use default message
			}
			throw new MarketplaceError(errorMessage, response.status);
		}

		const data: T = await response.json();
		return data;
	}
}

// ── Bundle extraction ──────────────────────────────────────────────

/**
 * Extract manifest + code files from a tarball.
 *
 * The tarball is a gzipped tar archive containing:
 * - manifest.json
 * - backend.js
 * - admin.js (optional)
 *
 * We use a minimal tar parser since we only need to read a few small files.
 */
async function extractBundle(tarballBytes: Uint8Array): Promise<PluginBundle> {
	// Decompress fully into memory first, then parse the tar.
	// Passing a pipeThrough() stream directly to unpackTar causes a backpressure
	// deadlock in workerd: the tar decoder's body-stream pull() needs more
	// decompressed data, but the upstream pipe is stalled waiting for the
	// decoder's writable side to drain — a circular dependency.
	const decompressedStream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(tarballBytes);
			controller.close();
		},
	}).pipeThrough(createGzipDecoder());

	// Collect decompressed bytes fully before parsing
	const decompressedBuf = await new Response(decompressedStream).arrayBuffer();
	const decompressedBytes = new Uint8Array(decompressedBuf);
	const decompressed = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(decompressedBytes);
			controller.close();
		},
	});

	const entries = await unpackTar(decompressed);

	const decoder = new TextDecoder();
	const files = new Map<string, string>();
	for (const entry of entries) {
		if (entry.data && entry.header.type === "file") {
			// Strip leading ./ prefix that tar tools commonly add
			const name = entry.header.name.replace(LEADING_DOT_SLASH, "");
			files.set(name, decoder.decode(entry.data));
		}
	}

	const manifestJson = files.get("manifest.json");
	const backendCode = files.get("backend.js");

	if (!manifestJson) {
		throw new MarketplaceError(
			"Invalid bundle: missing manifest.json",
			undefined,
			"INVALID_BUNDLE",
		);
	}
	if (!backendCode) {
		throw new MarketplaceError("Invalid bundle: missing backend.js", undefined, "INVALID_BUNDLE");
	}

	let manifest: PluginManifest;
	try {
		const parsed: unknown = JSON.parse(manifestJson);
		const result = pluginManifestSchema.safeParse(parsed);
		if (!result.success) {
			throw new MarketplaceError(
				"Invalid bundle: manifest.json failed validation",
				undefined,
				"INVALID_BUNDLE",
			);
		}
		// Elements are validated as unknown[] by Zod; cast to PluginManifest
		// for the Element[] type (Block Kit validation happens at render time).
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod types elements as unknown[]; Element type validated at render time
		manifest = result.data as unknown as PluginManifest;
	} catch (err) {
		if (err instanceof MarketplaceError) throw err;
		throw new MarketplaceError(
			"Invalid bundle: malformed manifest.json",
			undefined,
			"INVALID_BUNDLE",
		);
	}

	// Compute SHA-256 checksum of the tarball for verification
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Uint8Array is a valid BufferSource at runtime; TS lib mismatch
	const hashBuffer = await crypto.subtle.digest("SHA-256", tarballBytes as unknown as BufferSource);
	const hashArray = new Uint8Array(hashBuffer);
	const checksum = Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");

	return {
		manifest,
		backendCode,
		adminCode: files.get("admin.js"),
		checksum,
	};
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Generate a stable non-identifying site hash from the site origin.
 * The same origin always produces the same hash, so the marketplace
 * installs table deduplicates correctly per (plugin_id, site_hash).
 */
async function generateSiteHash(siteOrigin?: string): Promise<string> {
	const seed = siteOrigin ? `emdash-site:${siteOrigin}` : `emdash-anonymous`;
	try {
		const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
		const arr = new Uint8Array(hash);
		return Array.from(arr.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	} catch {
		// Fallback for environments without crypto.subtle: FNV-1a hash encoded as hex.
		// Deterministic, uniform distribution, no origin leakage.
		let h = 0x811c9dc5;
		for (let i = 0; i < seed.length; i++) {
			h ^= seed.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		const h2 = h ^ (h >>> 16);
		return (h >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
	}
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create a MarketplaceClient for the given marketplace URL.
 *
 * @param baseUrl - The marketplace API base URL (e.g. "https://marketplace.emdashcms.com")
 * @param siteOrigin - The origin of the EmDash site (e.g. "https://myblog.example.com").
 *   Used to generate a stable, non-identifying site hash for install deduplication.
 */
export function createMarketplaceClient(baseUrl: string, siteOrigin?: string): MarketplaceClient {
	return new MarketplaceClientImpl(baseUrl, siteOrigin);
}
