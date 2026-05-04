/**
 * WordPress import and source probing APIs
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

// =============================================================================
// WordPress Import API
// =============================================================================

/** Field compatibility status */
export type FieldCompatibility =
	| "compatible" // Field exists with compatible type
	| "type_mismatch" // Field exists but type differs
	| "missing"; // Field doesn't exist

/** Single field definition for import */
export interface ImportFieldDef {
	slug: string;
	label: string;
	type: string;
	required: boolean;
}

/** Schema status for a collection */
export interface CollectionSchemaStatus {
	exists: boolean;
	fieldStatus: Record<
		string,
		{
			status: FieldCompatibility;
			existingType?: string;
			requiredType: string;
		}
	>;
	canImport: boolean;
	reason?: string;
}

/** Post type with full schema info */
export interface PostTypeAnalysis {
	name: string;
	count: number;
	suggestedCollection: string;
	requiredFields: ImportFieldDef[];
	schemaStatus: CollectionSchemaStatus;
}

/** Individual attachment info for media import */
export interface AttachmentInfo {
	id?: number;
	title?: string;
	url?: string;
	filename?: string;
	mimeType?: string;
}

/** Navigation menu from WordPress */
export interface NavMenu {
	name: string;
	slug: string;
	count: number;
}

/** Custom taxonomy from WordPress */
export interface CustomTaxonomy {
	name: string;
	slug: string;
	count: number;
	hierarchical: boolean;
}

/** Author info from WordPress */
export interface WpAuthorInfo {
	id?: number;
	login?: string;
	email?: string;
	displayName?: string;
	postCount: number;
}

export interface WxrAnalysis {
	site: {
		title: string;
		url: string;
		tagline?: string;
		/** Slug of the page that WordPress serves at the site root, if detected */
		homePageSlug?: string;
	};
	postTypes: PostTypeAnalysis[];
	attachments: {
		count: number;
		items: AttachmentInfo[];
	};
	categories: number;
	tags: number;
	authors: WpAuthorInfo[];
	customFields: Array<{
		key: string;
		count: number;
		samples: string[];
		suggestedField: string;
		suggestedType: string;
		isInternal: boolean;
	}>;
	/** Navigation menus found in the export */
	navMenus?: NavMenu[];
	/** Custom taxonomies found in the export */
	customTaxonomies?: CustomTaxonomy[];
}

export interface PrepareRequest {
	postTypes: Array<{
		name: string;
		collection: string;
		fields: ImportFieldDef[];
	}>;
}

export interface PrepareResult {
	success: boolean;
	collectionsCreated: string[];
	fieldsCreated: Array<{ collection: string; field: string }>;
	errors: Array<{ collection: string; error: string }>;
}

/** Author mapping from WP author login to EmDash user ID */
export interface AuthorMapping {
	/** WordPress author login */
	wpLogin: string;
	/** WordPress author display name (for UI) */
	wpDisplayName: string;
	/** WordPress author email (for matching) */
	wpEmail?: string;
	/** EmDash user ID to assign (null = leave unassigned) */
	emdashUserId: string | null;
	/** Number of posts by this author */
	postCount: number;
}

export interface ImportConfig {
	postTypeMappings: Record<
		string,
		{
			collection: string;
			enabled: boolean;
		}
	>;
	skipExisting: boolean;
	/** Author mappings (WP author login -> EmDash user ID) */
	authorMappings?: Record<string, string | null>;
	/** Import navigation menus from nav_menu_item posts. Default: true. */
	importMenus?: boolean;
	/** Import site title, tagline and URL from the channel header. Default: true. */
	importSiteSettings?: boolean;
}

export interface ImportResult {
	success: boolean;
	imported: number;
	skipped: number;
	errors: Array<{ title: string; error: string }>;
	byCollection: Record<string, number>;
	/** Navigation menu import summary (when importMenus is enabled) */
	menus?: {
		created: number;
		items: number;
		replaced: number;
	};
	/** Site settings keys written (when importSiteSettings is enabled) */
	siteSettings?: {
		applied: string[];
	};
}

/**
 * Analyze a WordPress WXR file
 */
export async function analyzeWxr(file: File): Promise<WxrAnalysis> {
	const formData = new FormData();
	formData.append("file", file);

	const response = await apiFetch(`${API_BASE}/import/wordpress/analyze`, {
		method: "POST",
		body: formData,
	});
	return parseApiResponse<WxrAnalysis>(response, "Failed to analyze file");
}

/**
 * Prepare WordPress import (create collections/fields)
 */
export async function prepareWxrImport(request: PrepareRequest): Promise<PrepareResult> {
	const response = await apiFetch(`${API_BASE}/import/wordpress/prepare`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	return parseApiResponse<PrepareResult>(response, "Failed to prepare import");
}

/**
 * Execute WordPress import
 */
export async function executeWxrImport(file: File, config: ImportConfig): Promise<ImportResult> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("config", JSON.stringify(config));

	const response = await apiFetch(`${API_BASE}/import/wordpress/execute`, {
		method: "POST",
		body: formData,
	});
	return parseApiResponse<ImportResult>(response, "Failed to import");
}

// =============================================================================
// Media Import API
// =============================================================================

export interface MediaImportResult {
	imported: Array<{
		wpId?: number;
		originalUrl: string;
		newUrl: string;
		mediaId: string;
	}>;
	failed: Array<{
		wpId?: number;
		originalUrl: string;
		error: string;
	}>;
	urlMap: Record<string, string>;
}

/** Progress update sent during streaming media import */
export interface MediaImportProgress {
	type: "progress";
	current: number;
	total: number;
	filename?: string;
	status: "downloading" | "uploading" | "done" | "skipped" | "failed";
	error?: string;
}

export interface RewriteUrlsResult {
	updated: number;
	byCollection: Record<string, number>;
	urlsRewritten: number;
	errors: Array<{ collection: string; id: string; error: string }>;
}

/**
 * Import media from WordPress with streaming progress
 *
 * @param attachments - Array of attachments to import
 * @param onProgress - Callback for progress updates (optional)
 * @returns Final import result
 */
export async function importWxrMedia(
	attachments: AttachmentInfo[],
	onProgress?: (progress: MediaImportProgress) => void,
): Promise<MediaImportResult> {
	const response = await apiFetch(`${API_BASE}/import/wordpress/media`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ attachments, stream: !!onProgress }),
	});

	if (!response.ok) await throwResponseError(response, "Failed to import media");

	// If no progress callback, just parse as JSON (non-streaming mode)
	// Note: streaming NDJSON responses are excluded from the { data } envelope
	if (!onProgress) {
		return parseApiResponse<MediaImportResult>(response, "Failed to import media");
	}

	// Streaming mode: read NDJSON line by line
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Response body is not readable");
	}

	const decoder = new TextDecoder();
	let buffer = "";
	let result: MediaImportResult | null = null;

	while (true) {
		const { done, value } = await reader.read();

		if (done) break;

		buffer += decoder.decode(value, { stream: true });

		// Process complete lines
		const lines = buffer.split("\n");
		buffer = lines.pop() || ""; // Keep incomplete line in buffer

		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const parsed: { type?: string; imported?: unknown } = JSON.parse(line);
				if (parsed.type === "progress") {
					// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- SSE event data is parsed JSON; discriminated by type === "progress"
					onProgress(parsed as MediaImportProgress);
				} else if (parsed.type === "result" || parsed.imported) {
					// Final result (has type: "result" or is the result object)
					// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- SSE event data is parsed JSON; discriminated by type === "result"
					result = parsed as MediaImportResult;
				}
			} catch {
				// Ignore parse errors for incomplete JSON
				console.warn("Failed to parse NDJSON line:", line);
			}
		}
	}

	// Process any remaining data in buffer
	if (buffer.trim()) {
		try {
			const parsed: { type?: string; imported?: unknown } = JSON.parse(buffer);
			if (parsed.type === "result" || parsed.imported) {
				// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- SSE event data is parsed JSON; discriminated by type === "result"
				result = parsed as MediaImportResult;
			}
		} catch {
			console.warn("Failed to parse final NDJSON:", buffer);
		}
	}

	if (!result) {
		throw new Error("No result received from media import");
	}

	return result;
}

// =============================================================================
// Import Source Probing
// =============================================================================

/** Capabilities of an import source */
export interface SourceCapabilities {
	publicContent: boolean;
	privateContent: boolean;
	customPostTypes: boolean;
	allMeta: boolean;
	mediaStream: boolean;
}

/** Auth requirements for import */
export interface SourceAuth {
	type: "oauth" | "token" | "password" | "none";
	provider?: string;
	oauthUrl?: string;
	instructions?: string;
}

/** Suggested action after probing */
export type SuggestedAction =
	| { type: "proceed" }
	| { type: "oauth"; url: string; provider: string }
	| { type: "upload"; instructions: string }
	| { type: "install-plugin"; instructions: string };

/** Result from probing a single source */
export interface SourceProbeResult {
	sourceId: string;
	confidence: "definite" | "likely" | "possible";
	detected: {
		platform: string;
		version?: string;
		siteTitle?: string;
		siteUrl?: string;
	};
	capabilities: SourceCapabilities;
	auth?: SourceAuth;
	suggestedAction: SuggestedAction;
	preview?: {
		posts?: number;
		pages?: number;
		media?: number;
	};
}

/** Combined probe result */
export interface ProbeResult {
	url: string;
	isWordPress: boolean;
	bestMatch: SourceProbeResult | null;
	allMatches: SourceProbeResult[];
}

/**
 * Probe a URL to detect import source
 */
export async function probeImportUrl(url: string): Promise<ProbeResult> {
	const response = await apiFetch(`${API_BASE}/import/probe`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
	});
	const data = await parseApiResponse<{ result: ProbeResult }>(response, "Failed to probe URL");
	return data.result;
}

/**
 * Rewrite URLs in content after media import
 */
export async function rewriteContentUrls(
	urlMap: Record<string, string>,
	collections?: string[],
): Promise<RewriteUrlsResult> {
	const response = await apiFetch(`${API_BASE}/import/wordpress/rewrite-urls`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ urlMap, collections }),
	});
	return parseApiResponse<RewriteUrlsResult>(response, "Failed to rewrite URLs");
}

// =============================================================================
// WordPress Plugin Direct Import API
// =============================================================================

/** WordPress Plugin analysis result */
export interface WpPluginAnalysis {
	sourceId: string;
	site: {
		title: string;
		url: string;
	};
	postTypes: PostTypeAnalysis[];
	attachments: {
		count: number;
		items: AttachmentInfo[];
	};
	categories: number;
	tags: number;
	authors: WpAuthorInfo[];
	/** Navigation menus found via the plugin */
	navMenus?: NavMenu[];
	/** Custom taxonomies found via the plugin */
	customTaxonomies?: CustomTaxonomy[];
}

/**
 * Analyze a WordPress site with EmDash Exporter plugin
 */
export async function analyzeWpPluginSite(url: string, token: string): Promise<WpPluginAnalysis> {
	const response = await apiFetch(`${API_BASE}/import/wordpress-plugin/analyze`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url, token }),
	});
	const data = await parseApiResponse<{ analysis: WpPluginAnalysis }>(
		response,
		"Failed to analyze WordPress site",
	);
	return data.analysis;
}

/**
 * Execute import from WordPress plugin API
 */
export async function executeWpPluginImport(
	url: string,
	token: string,
	config: ImportConfig,
): Promise<ImportResult> {
	const response = await apiFetch(`${API_BASE}/import/wordpress-plugin/execute`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url, token, config }),
	});
	const data = await parseApiResponse<{ result: ImportResult }>(
		response,
		"Failed to import from WordPress",
	);
	return data.result;
}
