/**
 * API client for EmDash admin
 *
 * Re-exports all API modules for backwards compatibility.
 */

// Base client and shared types
export {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type FindManyResult,
	type AdminManifest,
	fetchManifest,
} from "./client.js";

// Content CRUD and revisions
export {
	type ContentSeo,
	type ContentSeoInput,
	type ContentItem,
	type CreateContentInput,
	type UpdateContentInput,
	type TrashedContentItem,
	type PreviewUrlResponse,
	type Revision,
	type RevisionListResponse,
	type TranslationSummary,
	type TranslationsResponse,
	getDraftStatus,
	fetchContentList,
	fetchContent,
	fetchTranslations,
	createContent,
	updateContent,
	deleteContent,
	fetchTrashedContent,
	restoreContent,
	permanentDeleteContent,
	duplicateContent,
	scheduleContent,
	unscheduleContent,
	getPreviewUrl,
	publishContent,
	unpublishContent,
	discardDraft,
	compareRevisions,
	fetchRevisions,
	fetchRevision,
	restoreRevision,
} from "./content.js";

// Media
export {
	type MediaItem,
	type MediaProviderCapabilities,
	type MediaProviderInfo,
	type MediaProviderItem,
	fetchMediaList,
	uploadMedia,
	deleteMedia,
	updateMedia,
	fetchMediaProviders,
	fetchProviderMedia,
	uploadToProvider,
	deleteFromProvider,
} from "./media.js";

// Schema (Content Type Builder)
export {
	type FieldType,
	type SchemaCollection,
	type SchemaField,
	type SchemaCollectionWithFields,
	type CreateCollectionInput,
	type UpdateCollectionInput,
	type CreateFieldInput,
	type UpdateFieldInput,
	type OrphanedTable,
	fetchCollections,
	fetchCollection,
	createCollection,
	updateCollection,
	deleteCollection,
	fetchFields,
	createField,
	updateField,
	deleteField,
	reorderFields,
	fetchOrphanedTables,
	registerOrphanedTable,
} from "./schema.js";

// Plugins
export {
	type PluginInfo,
	fetchPlugins,
	fetchPlugin,
	enablePlugin,
	disablePlugin,
} from "./plugins.js";

// Settings
export { type SiteSettings, fetchSettings, updateSettings } from "./settings.js";

// Users, passkeys, allowed domains
export {
	type UserListItem,
	type UserDetail,
	type UpdateUserInput,
	type PasskeyInfo,
	type AllowedDomain,
	type CreateAllowedDomainInput,
	type UpdateAllowedDomainInput,
	type SignupVerifyResult,
	fetchUsers,
	fetchUser,
	updateUser,
	sendRecoveryLink,
	disableUser,
	enableUser,
	inviteUser,
	fetchPasskeys,
	renamePasskey,
	deletePasskey,
	fetchAllowedDomains,
	createAllowedDomain,
	updateAllowedDomain,
	deleteAllowedDomain,
	requestSignup,
	verifySignupToken,
	completeSignup,
	hasAllowedDomains,
} from "./users.js";

// Bylines
export {
	type BylineSummary,
	type BylineInput,
	type BylineCreditInput,
	fetchBylines,
	fetchByline,
	createByline,
	updateByline,
	deleteByline,
} from "./bylines.js";

// Menus
export {
	type Menu,
	type MenuItem,
	type MenuWithItems,
	type CreateMenuInput,
	type UpdateMenuInput,
	type CreateMenuItemInput,
	type UpdateMenuItemInput,
	type ReorderMenuItemsInput,
	fetchMenus,
	fetchMenu,
	createMenu,
	updateMenu,
	deleteMenu,
	createMenuItem,
	updateMenuItem,
	deleteMenuItem,
	reorderMenuItems,
} from "./menus.js";

// Widget areas
export {
	type WidgetArea,
	type Widget,
	type WidgetComponent,
	type CreateWidgetAreaInput,
	type CreateWidgetInput,
	type UpdateWidgetInput,
	fetchWidgetAreas,
	fetchWidgetArea,
	createWidgetArea,
	deleteWidgetArea,
	createWidget,
	updateWidget,
	deleteWidget,
	reorderWidgets,
	fetchWidgetComponents,
} from "./widgets.js";

// Sections
export {
	type SectionSource,
	type Section,
	type SectionsResult,
	type CreateSectionInput,
	type UpdateSectionInput,
	type GetSectionsOptions,
	fetchSections,
	fetchSection,
	createSection,
	updateSection,
	deleteSection,
} from "./sections.js";

// Taxonomies
export {
	type TaxonomyTerm,
	type TaxonomyDef,
	type CreateTaxonomyInput,
	type CreateTermInput,
	type UpdateTermInput,
	fetchTaxonomyDefs,
	fetchTaxonomyDef,
	fetchTerms,
	createTaxonomy,
	createTerm,
	updateTerm,
	deleteTerm,
} from "./taxonomies.js";

// WordPress import
export {
	type FieldCompatibility,
	type ImportFieldDef,
	type CollectionSchemaStatus,
	type PostTypeAnalysis,
	type AttachmentInfo,
	type NavMenu,
	type CustomTaxonomy,
	type WpAuthorInfo,
	type WxrAnalysis,
	type PrepareRequest,
	type PrepareResult,
	type AuthorMapping,
	type ImportConfig,
	type ImportResult,
	type MediaImportResult,
	type MediaImportProgress,
	type RewriteUrlsResult,
	type SourceCapabilities,
	type SourceAuth,
	type SuggestedAction,
	type SourceProbeResult,
	type ProbeResult,
	type WpPluginAnalysis,
	analyzeWxr,
	prepareWxrImport,
	executeWxrImport,
	importWxrMedia,
	probeImportUrl,
	rewriteContentUrls,
	analyzeWpPluginSite,
	executeWpPluginImport,
} from "./import.js";

// API Tokens
export {
	type ApiTokenInfo,
	type ApiTokenCreateResult,
	type CreateApiTokenInput,
	API_TOKEN_SCOPES,
	fetchApiTokens,
	createApiToken,
	revokeApiToken,
} from "./api-tokens.js";

// Comments
export {
	type AdminComment,
	type CommentStatus,
	type CommentCounts,
	type BulkAction,
	fetchComments,
	fetchCommentCounts,
	fetchComment,
	updateCommentStatus,
	deleteComment,
	bulkCommentAction,
} from "./comments.js";

// Dashboard
export {
	type CollectionStats,
	type RecentItem,
	type DashboardStats,
	fetchDashboardStats,
} from "./dashboard.js";

// Search
export { type SearchEnableResult, setSearchEnabled } from "./search.js";

// Marketplace
export {
	type MarketplaceAuthor,
	type MarketplaceAuditSummary,
	type MarketplaceImageAuditSummary,
	type MarketplaceVersion,
	type MarketplacePluginSummary,
	type MarketplacePluginDetail,
	type MarketplaceSearchResult,
	type MarketplaceSearchOpts,
	type PluginUpdateInfo,
	type InstallPluginOpts,
	type UpdatePluginOpts,
	type UninstallPluginOpts,
	searchMarketplace,
	fetchMarketplacePlugin,
	installMarketplacePlugin,
	updateMarketplacePlugin,
	uninstallMarketplacePlugin,
	checkPluginUpdates,
	CAPABILITY_LABELS,
	describeCapability,
} from "./marketplace.js";

// Email settings
export {
	type EmailProvider,
	type EmailSettings,
	fetchEmailSettings,
	sendTestEmail,
} from "./email-settings.js";

// Theme marketplace
export {
	type ThemeAuthor,
	type ThemeAuthorDetail,
	type ThemeSummary,
	type ThemeDetail,
	type ThemeSearchResult,
	type ThemeSearchOpts,
	searchThemes,
	fetchTheme,
	generatePreviewUrl,
} from "./theme-marketplace.js";

// Redirects
export {
	type Redirect,
	type NotFoundSummary,
	type CreateRedirectInput,
	type UpdateRedirectInput,
	type RedirectListOptions,
	type RedirectListResult,
	fetchRedirects,
	createRedirect,
	updateRedirect,
	deleteRedirect,
	fetch404Summary,
} from "./redirects.js";

// Current user
export { type CurrentUser, useCurrentUser } from "./current-user.js";

// AI
export { rewriteText, isAiConfigured, type AiRewriteResult } from "./ai.js";
