/**
 * Import system
 *
 * Provides a pluggable system for importing content from various sources.
 */

// Core types
export type {
	ImportSource,
	ImportAnalysis,
	ImportContext,
	SourceInput,
	FileInput,
	UrlInput,
	OAuthInput,
	SourceProbeResult,
	ProbeResult,
	SourceAuth,
	SourceCapabilities,
	SuggestedAction,
	PostTypeAnalysis,
	ImportFieldDef,
	FieldCompatibility,
	CollectionSchemaStatus,
	AttachmentInfo,
	ImportAuthorInfo,
	NormalizedItem,
	ImportConfig,
	ImportResult,
	FetchOptions,
	PostTypeMapping,
	NavMenuAnalysis,
	TaxonomyAnalysis,
} from "./types.js";

// Menu import
export {
	importMenusFromWxr,
	importMenusFromPlugin,
	type MenuImportResult,
	type PluginMenu,
	type PluginMenuItem,
} from "./menus.js";

// Sections import
export { importReusableBlocksAsSections, type SectionsImportResult } from "./sections.js";

// Site settings import
export {
	importSiteSettings,
	parseSiteSettingsFromPlugin,
	type SiteSettingsAnalysis,
	type SettingsImportResult,
	type WidgetAreaAnalysis,
} from "./settings.js";

// Registry
export {
	registerSource,
	getSource,
	getAllSources,
	getFileSources,
	getUrlSources,
	probeUrl,
	clearSources,
} from "./registry.js";

// SSRF protection
export { validateExternalUrl, ssrfSafeFetch, SsrfError } from "./ssrf.js";

// Ghost import helpers
export {
	parseGhostExportData,
	parseGhostExportString,
	buildGhostTagSlugsByPostId,
	buildGhostPrimaryAuthorByPostId,
	buildGhostAuthorPostCounts,
	buildGhostPostMetaByPostId,
	getGhostSettingValue,
	sortGhostPostsByPublishedDate,
} from "./ghost/parser.js";
export { rewriteGhostHtml, normalizeGhostMediaUrl, buildGhostExcerpt, stripGhostHtml } from "./ghost/rewrite.js";
export { buildGhostSeedFragment, type GhostSeedFragment, type GhostToSeedConfig } from "./ghost/to-seed.js";

// Sources
export { ghostExportSource } from "./sources/ghost-export.js";
export { wxrSource } from "./sources/wxr.js";
export { wordpressRestSource } from "./sources/wordpress-rest.js";
export {
	wordpressPluginSource,
	createBasicAuthToken,
	fetchPluginMedia,
	fetchPluginTaxonomies,
} from "./sources/wordpress-plugin.js";

// Auto-register built-in sources
import { registerSource } from "./registry.js";
import { ghostExportSource } from "./sources/ghost-export.js";
import { wordpressPluginSource } from "./sources/wordpress-plugin.js";
import { wordpressRestSource } from "./sources/wordpress-rest.js";
import { wxrSource } from "./sources/wxr.js";

// Register in priority order (most specific first)
// Plugin source first - if they have our plugin, use it
registerSource(wordpressPluginSource);
registerSource(wordpressRestSource);
registerSource(ghostExportSource);
registerSource(wxrSource);
