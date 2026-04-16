/**
 * Plugin System Exports
 *
 * Unified plugin API with:
 * - Single context shape for all hooks and routes
 * - Paginated queries (no async iterators)
 * - Capability-gated APIs
 *
 */

// definePlugin
export { definePlugin } from "./define-plugin.js";

// Standard plugin adapter
export { adaptSandboxEntry } from "./adapt-sandbox-entry.js";

// Manifest validation
export { pluginManifestSchema, PLUGIN_CAPABILITIES, HOOK_NAMES } from "./manifest-schema.js";
export type { ValidatedPluginManifest } from "./manifest-schema.js";

// Request metadata
export { extractRequestMeta, sanitizeHeadersForSandbox } from "./request-meta.js";

// Context factory
export {
	PluginContextFactory,
	createPluginContext,
	createKVAccess,
	createStorageAccess,
	createContentAccess,
	createContentAccessWithWrite,
	createMediaAccess,
	createMediaAccessWithWrite,
	createHttpAccess,
	createUnrestrictedHttpAccess,
	createBlockedHttpAccess,
	createLogAccess,
	createUserAccess,
	createUrlHelper,
	createSiteInfo,
} from "./context.js";
export type { PluginContextFactoryOptions } from "./context.js";

// Hooks
export { HookPipeline, createHookPipeline } from "./hooks.js";
export type { HookResult } from "./hooks.js";

// Email pipeline
export { EmailPipeline, EmailNotConfiguredError, EmailRecursionError } from "./email.js";
export { DEV_CONSOLE_EMAIL_PLUGIN_ID, getDevEmails, clearDevEmails } from "./email-console.js";
export type { StoredEmail } from "./email-console.js";

// Routes
export {
	PluginRouteHandler,
	PluginRouteRegistry,
	PluginRouteError,
	createRouteRegistry,
} from "./routes.js";
export type { RouteResult, InvokeRouteOptions } from "./routes.js";

// Manager
export { PluginManager, createPluginManager } from "./manager.js";
export type { PluginManagerOptions, PluginState } from "./manager.js";

// Sandbox
export {
	NoopSandboxRunner,
	SandboxNotAvailableError,
	SandboxUnavailableError,
	createNoopSandboxRunner,
} from "./sandbox/index.js";
export type {
	SandboxRunner,
	SandboxedPlugin,
	SandboxRunnerFactory,
	SandboxOptions,
	SandboxEmailMessage,
	SandboxEmailSendCallback,
	ResourceLimits,
	PluginCodeStorage,
	SerializedRequest,
} from "./sandbox/index.js";

// Types
export type {
	// Core types
	PluginCapability,
	PluginStorageConfig,
	StorageCollectionConfig,
	PaginatedResult,
	QueryOptions,
	WhereClause,
	WhereValue,
	RangeFilter,
	InFilter,
	StartsWithFilter,

	// Context APIs
	PluginContext,
	StorageCollection,
	KVAccess,
	ContentAccess,
	ContentAccessWithWrite,
	MediaAccess,
	MediaAccessWithWrite,
	HttpAccess,
	LogAccess,
	SiteInfo,
	UserInfo,
	UserAccess,
	ContentItem,
	MediaItem,
	ContentListOptions,
	MediaListOptions,

	// Hook types
	PluginHooks,
	HookConfig,
	HookName,
	ResolvedHook,
	ResolvedPluginHooks,
	ContentHookEvent,
	ContentDeleteEvent,
	ContentPublishStateChangeEvent,
	MediaUploadEvent,
	MediaAfterUploadEvent,
	LifecycleEvent,
	UninstallEvent,

	// Email types
	EmailAccess,
	EmailMessage,
	EmailBeforeSendEvent,
	EmailDeliverEvent,
	EmailAfterSendEvent,
	EmailBeforeSendHandler,
	EmailDeliverHandler,
	EmailAfterSendHandler,

	// Handler types
	ContentBeforeSaveHandler,
	ContentAfterSaveHandler,
	ContentBeforeDeleteHandler,
	ContentAfterDeleteHandler,
	MediaBeforeUploadHandler,
	MediaAfterUploadHandler,
	LifecycleHandler,
	UninstallHandler,

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

	// Request metadata types
	RequestMeta,
	GeoInfo,

	// Route types
	PluginRoute,
	RouteContext,

	// Admin types
	PluginAdminConfig,
	PluginAdminPage,
	PluginDashboardWidget,
	PluginAdminExports,
	FieldWidgetConfig,
	PortableTextBlockConfig,
	PortableTextBlockField,
	SettingField,
	SettingFieldType,

	// Plugin definition
	PluginDefinition,
	ResolvedPlugin,
	PluginManifest,

	// Standard plugin format
	StandardPluginDefinition,
	StandardHookHandler,
	StandardHookEntry,
	StandardRouteHandler,
	StandardRouteEntry,
} from "./types.js";
export { isStandardPluginDefinition } from "./types.js";
