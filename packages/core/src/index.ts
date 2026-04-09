// Database (only types and utilities - internal functions not exported)
export { EmDashDatabaseError, getMigrationStatus } from "./database/index.js";
export type {
	DatabaseConfig,
	MigrationStatus,
	Database,
	UserTable,
	MediaTable,
} from "./database/index.js";

// Repositories
export {
	ContentRepository,
	MediaRepository,
	EmDashValidationError,
} from "./database/repositories/index.js";
export type {
	ContentItem,
	ContentSeo,
	ContentSeoInput,
	CreateContentInput,
	UpdateContentInput,
	FindManyOptions,
	FindManyResult,
} from "./database/repositories/index.js";
export type { MediaItem, CreateMediaInput } from "./database/repositories/media.js";

// Fields
export { portableText, image, reference } from "./fields/index.js";
export { normalizeMediaValue } from "./media/normalize.js";
export { generatePlaceholder } from "./media/placeholder.js";
export type { PlaceholderData } from "./media/placeholder.js";
export type {
	FieldDefinition,
	FieldUIHints,
	PortableTextBlock,
	MediaValue,
	ImageValue,
	FileValue,
} from "./fields/index.js";

// API handlers
export {
	handleContentList,
	handleContentGet,
	handleContentGetIncludingTrashed,
	handleContentCreate,
	handleContentUpdate,
	handleContentDelete,
	handleContentDuplicate,
	handleContentRestore,
	handleContentPermanentDelete,
	handleContentListTrashed,
	handleContentCountTrashed,
	handleContentPublish,
	handleContentUnpublish,
	handleContentSchedule,
	handleContentUnschedule,
	handleContentCountScheduled,
	handleContentDiscardDraft,
	handleContentCompare,
	handleContentTranslations,
	handleMediaList,
	handleMediaGet,
	handleMediaCreate,
	handleMediaUpdate,
	handleMediaDelete,
	handleRevisionList,
	handleRevisionGet,
	handleRevisionRestore,
	generateManifest,
} from "./api/index.js";
export type {
	ListResponse,
	ContentListResponse,
	ContentResponse,
	MediaListResponse,
	MediaResponse,
	RevisionListResponse,
	RevisionResponse,
	ManifestResponse,
	FieldDescriptor,
	ApiContext,
} from "./api/index.js";

// Content converters (Portable Text <-> ProseMirror)
export { prosemirrorToPortableText, portableTextToProsemirror } from "./content/index.js";
export type {
	PortableTextSpan,
	PortableTextMarkDef,
	PortableTextLinkMark,
	PortableTextTextBlock,
	PortableTextImageBlock,
	PortableTextCodeBlock,
	PortableTextUnknownBlock,
	ProseMirrorMark,
	ProseMirrorNode,
	ProseMirrorDocument,
} from "./content/index.js";

// Utilities
export { ulid } from "ulidx";
export { computeContentHash, hashString } from "./utils/hash.js";
export { sanitizeHref, isSafeHref } from "./utils/url.js";

// Live Collections query functions (loader is in emdash/runtime)
export {
	getEmDashCollection,
	getEmDashEntry,
	getEditMeta,
	getTranslations,
	resolveEmDashPath,
} from "./query.js";
export type {
	CacheHint,
	CollectionFilter,
	CollectionResult,
	ContentEntry,
	EditFieldMeta,
	EntryResult,
	EmDashCollections,
	InferCollectionData,
	ResolvePathResult,
	TranslationSummary,
	TranslationsResult,
} from "./query.js";

// Request context (ALS-based ambient state for query functions)
export { getRequestContext, runWithContext } from "./request-context.js";
export type { EmDashRequestContext } from "./request-context.js";

// i18n configuration (from Astro config)
export { getI18nConfig, isI18nEnabled, getFallbackChain } from "./i18n/config.js";
export type { I18nConfig } from "./i18n/config.js";

// Visual editing
export {
	createEditable,
	createNoop,
	type CMSAnnotation,
	type EditProxy,
	type FieldAnnotation,
} from "./visual-editing/editable.js";

// Re-export loader types (but not the loader itself - use emdash/runtime)
export type {
	EntryData,
	EntryFilter,
	CollectionFilter as LoaderCollectionFilter,
} from "./loader.js";

// WordPress import
export { parseWxr, parseWxrString } from "./cli/wxr/parser.js";
export type {
	WxrData,
	WxrSite,
	WxrPost,
	WxrAttachment,
	WxrCategory,
	WxrTag,
	WxrAuthor,
} from "./cli/wxr/parser.js";

// Storage types
export type {
	Storage,
	SignedUploadUrl,
	SignedUploadOptions,
	UploadResult,
	DownloadResult,
	ListResult,
	ListOptions,
	FileInfo,
	S3StorageConfig,
	LocalStorageConfig,
	StorageDescriptor,
	CreateStorageFn,
} from "./storage/types.js";
export { EmDashStorageError } from "./storage/types.js";

// Plugin system
export {
	definePlugin,
	adaptSandboxEntry,
	isStandardPluginDefinition,
	pluginManifestSchema,
	createHookPipeline,
	HookPipeline,
	PluginManager,
	createPluginManager,
	PluginRouteError,
	// Sandbox
	NoopSandboxRunner,
	SandboxNotAvailableError,
	createNoopSandboxRunner,
} from "./plugins/index.js";
export type {
	PluginDefinition,
	ResolvedPlugin,
	PluginCapability,
	PluginContext,
	PluginStorageConfig,
	StorageCollection,
	KVAccess,
	ContentAccess,
	MediaAccess,
	HttpAccess,
	LogAccess,
	PluginHooks,
	HookConfig,
	HookName,
	ResolvedHook,
	ResolvedPluginHooks,
	ContentHookEvent,
	MediaUploadEvent,
	HookResult,
	PluginRoute,
	RouteContext,
	PluginAdminConfig,
	PluginAdminPage,
	PluginAdminExports,
	FieldWidgetConfig,
	PortableTextBlockConfig,
	PortableTextBlockField,
	// Comment types
	CommentBeforeCreateEvent,
	CommentModerateEvent,
	CommentAfterCreateEvent,
	CommentAfterModerateEvent,
	CommentBeforeCreateHandler,
	CommentModerateHandler,
	CommentAfterCreateHandler,
	CommentAfterModerateHandler,
	ModerationDecision,
	CollectionCommentSettings,
	StoredComment,

	// Standard plugin format
	StandardPluginDefinition,
	StandardHookHandler,
	StandardHookEntry,
	StandardRouteHandler,
	StandardRouteEntry,

	// Sandbox types
	SandboxRunner,
	SandboxedPlugin,
	SandboxRunnerFactory,
	SandboxOptions,
	SandboxEmailMessage,
	SandboxEmailSendCallback,
	PluginManifest,
	ValidatedPluginManifest,
	SerializedRequest,
} from "./plugins/index.js";

// Plugin descriptor (for astro.config.mjs)
export type { PluginDescriptor } from "./astro/integration/runtime.js";

// Schema registry
export { SchemaRegistry, SchemaError, getCollectionInfo } from "./schema/index.js";
export type {
	FieldType,
	ColumnType,
	CollectionSupport,
	CollectionSource,
	FieldValidation,
	FieldWidgetOptions,
	Collection,
	Field,
	CreateCollectionInput,
	UpdateCollectionInput,
	CreateFieldInput,
	UpdateFieldInput,
	CollectionWithFields,
} from "./schema/index.js";
export {
	FIELD_TYPE_TO_COLUMN,
	RESERVED_FIELD_SLUGS,
	RESERVED_COLLECTION_SLUGS,
} from "./schema/index.js";

// Import sources system
export {
	registerSource,
	getSource,
	getAllSources,
	getFileSources,
	getUrlSources,
	probeUrl,
	clearSources,
	wxrSource,
	wordpressRestSource,
	importReusableBlocksAsSections,
} from "./import/index.js";
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
	NormalizedItem,
	ImportConfig,
	ImportResult,
	FetchOptions,
	PostTypeMapping,
} from "./import/index.js";

// Preview system
export {
	generatePreviewToken,
	verifyPreviewToken,
	parseContentId,
	getPreviewUrl,
	buildPreviewUrl,
	isPreviewRequest,
	getPreviewToken,
} from "./preview/index.js";
export type {
	PreviewTokenPayload,
	GeneratePreviewTokenOptions,
	VerifyPreviewTokenResult,
	VerifyPreviewTokenOptions,
	GetPreviewUrlOptions,
} from "./preview/index.js";
// Site Settings
export { getSiteSetting, getSiteSettings, setSiteSettings } from "./settings/index.js";
export type {
	SiteSettings,
	SiteSettingKey,
	MediaReference,
	SeoSettings,
} from "./settings/types.js";

// SEO
export { getSeoMeta, getContentSeo } from "./seo/index.js";
export type { SeoMeta, SeoMetaOptions } from "./seo/index.js";

// Public page contribution types
export type {
	PagePlacement,
	PublicPageContext,
	PageMetadataEvent,
	PageMetadataContribution,
	PageMetadataHandler,
	PageFragmentEvent,
	PageFragmentContribution,
	PageFragmentHandler,
} from "./plugins/types.js";

// Comments
export { getComments, getCommentCount } from "./comments/query.js";
export type { GetCommentsOptions, GetCommentsResult } from "./comments/query.js";

// Menus
export { getMenu, getMenus } from "./menus/index.js";
export type {
	Menu,
	MenuItem,
	MenuItemType,
	CreateMenuInput,
	UpdateMenuInput,
	CreateMenuItemInput,
	UpdateMenuItemInput,
	ReorderMenuItemsInput,
} from "./menus/types.js";

// Bylines
export { getByline, getBylineBySlug } from "./bylines/index.js";
export type { BylineSummary, ContentBylineCredit } from "./database/repositories/types.js";

// Taxonomies
export {
	getTaxonomyDefs,
	getTaxonomyDef,
	getTaxonomyTerms,
	getTerm,
	getEntryTerms,
	getTermsForEntries,
	getEntriesByTerm,
} from "./taxonomies/index.js";
export type {
	TaxonomyDef,
	TaxonomyTerm,
	TaxonomyTermRow,
	CreateTermInput,
	UpdateTermInput,
} from "./taxonomies/types.js";

// Widgets
export { getWidgetArea, getWidgetAreas, getWidgetComponents } from "./widgets/index.js";
export type {
	Widget,
	WidgetArea,
	WidgetType,
	WidgetComponentDef,
	PropDef,
	CreateWidgetAreaInput,
	CreateWidgetInput,
	UpdateWidgetInput,
	ReorderWidgetsInput,
} from "./widgets/index.js";

// Sections
export { getSection, getSections } from "./sections/index.js";
export type {
	Section,
	SectionSource,
	CreateSectionInput,
	UpdateSectionInput,
	GetSectionsOptions,
} from "./sections/index.js";

// Seeding
export { applySeed, validateSeed } from "./seed/index.js";
export type {
	SeedFile,
	SeedCollection,
	SeedField,
	SeedTaxonomy,
	SeedTaxonomyTerm,
	SeedMenu,
	SeedMenuItem,
	SeedWidgetArea,
	SeedWidget,
	SeedContentEntry,
	SeedApplyOptions,
	SeedApplyResult,
	ValidationResult,
} from "./seed/index.js";

// Search
export {
	FTSManager,
	search,
	searchWithDb,
	searchCollection,
	getSuggestions,
	getSearchStats,
	extractPlainText,
	extractSearchableFields,
} from "./search/index.js";
export type {
	SearchConfig,
	SearchOptions,
	CollectionSearchOptions,
	SearchResult,
	SearchResponse,
	SuggestOptions,
	Suggestion,
	SearchStats,
} from "./search/index.js";

// Auth types (for platform-specific auth providers and pluggable login methods)
export type {
	AuthDescriptor,
	AuthProviderDescriptor,
	AuthProviderAdminExports,
	AuthProviderModule,
	AuthResult,
	AuthRouteDescriptor,
	ExternalAuthConfig,
} from "./auth/types.js";

// Database descriptor (for platform-specific database adapters)
export type {
	DatabaseDescriptor,
	DatabaseDialectType,
	SqliteConfig,
	LibsqlConfig,
	PostgresConfig,
} from "./db/adapters.js";
