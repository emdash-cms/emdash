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
	createContentAccessWithWrite,
	createCommentAccess,
	createRedirectAccess,
	RedirectAccessError,
	createSchemaAccess,
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
export { createContentAccess } from "./content-access.js";
export type { ContentActionCallbacks, PluginContextFactoryOptions } from "./context.js";
export { CronAccessImpl } from "./cron.js";
export {
	DEFAULT_PLUGIN_MEDIA_READ_BYTES,
	MAX_PLUGIN_MEDIA_READ_BYTES,
	parsePluginMediaMetadataPatch,
	readPluginMediaBytes,
	toPluginMediaItem,
	updatePluginMediaMetadata,
} from "./media.js";

// Hooks
export { HookPipeline, createHookPipeline } from "./hooks.js";
export type { HookResult } from "./hooks.js";
export { ContentSaveRejectedError, isContentSaveRejection } from "./save-rejection.js";
export {
	SCHEDULED_POLICY_REJECTION_PREFIX,
	isScheduledPolicyRejection,
	scheduledPolicyRejectionKey,
} from "./content-policy.js";
export type {
	ScheduledPolicyRejection,
	VersionedScheduledPolicyRejection,
} from "./content-policy.js";

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

// Scheduler (Node timer-based heartbeat; consumed by the generated
// virtual:emdash/scheduler module on non-serverless adapters)
export { NodeCronScheduler } from "./scheduler/node.js";
export type { CronScheduler, SystemCleanupFn } from "./scheduler/types.js";

// Sandbox
export {
	NoopSandboxRunner,
	SandboxNotAvailableError,
	SandboxUnavailableError,
	createSandboxRouteError,
	createSandboxRouteErrorEnvelope,
	getSandboxRouteErrorDetails,
	getSandboxRouteErrorEnvelope,
	MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH,
	SANDBOX_HOOK_RESULT_VERSION,
	inspectSandboxHookResult,
	createNoopSandboxRunner,
} from "./sandbox/index.js";
export type {
	SandboxRunner,
	SandboxedPluginInstance,
	SandboxInvocationOptions,
	SandboxRunnerFactory,
	SandboxOptions,
	SandboxEmailMessage,
	SandboxEmailSendCallback,
	SandboxCommentModerateCallback,
	SandboxContentCreateCallback,
	ResourceLimits,
	PluginCodeStorage,
	SerializedRequest,
	SandboxRouteErrorCode,
	SandboxRouteErrorDetails,
	SandboxRouteErrorEnvelope,
	SandboxHookErrorEnvelope,
	SandboxHookResultInspection,
	SandboxSaveRejectedError,
} from "./sandbox/index.js";

export { StorageSerializationError } from "./storage-query.js";
export {
	PluginSettingEncryptionError,
	createPluginSecretRedactor,
	createSettingsAccess,
	decodePluginSettingValue,
	encryptPluginSetting,
	isEncryptedPluginSetting,
} from "./settings.js";
export type { EncryptedPluginSetting, PluginSecretRedactor } from "./settings.js";

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
	NumericDelta,
	UpdateIfArgs,
	UpdateIfResult,
	VersionedValue,
	ConditionalWriteResult,
	ConditionalDeleteResult,
	KVAccess,
	SettingsAccess,
	ContentAccess,
	ContentAccessWithWrite,
	ContentPublicationAccess,
	ContentRestoreAccess,
	VersionedContentItem,
	MediaAccess,
	MediaAccessWithWrite,
	MediaBytes,
	MediaMetadataPatch,
	HttpAccess,
	LogAccess,
	SiteInfo,
	UserInfo,
	UserAccess,
	ContentItem,
	ContentTranslationSummary,
	ContentRevisionInfo,
	SchemaAccess,
	CollectionSchemaInfo,
	FieldSchemaInfo,
	ContentCreateOptions,
	ContentWriteInput,
	CronTaskInfo,
	MediaItem,
	ContentListOptions,
	MediaListOptions,
	TaxonomyAccess,
	TaxonomyAccessWithWrite,
	TaxonomyDefInfo,
	TaxonomyTermInfo,
	TaxonomyTermCreateInput,
	TaxonomyReadOptions,
	RedirectAccess,
	RedirectAccessWithWrite,
	RedirectCreateInput,
	RedirectInfo,
	RedirectListOptions,
	RedirectStatus,
	RedirectUpdateInput,
	VersionedRedirect,

	// Hook types
	PluginHooks,
	HookConfig,
	HookName,
	ResolvedHook,
	ResolvedPluginHooks,
	ActorInfo,
	ContentActionOrigin,
	ContentHookEvent,
	ContentPolicyDecision,
	ContentPolicyEvent,
	ContentSchedulePolicyEvent,
	ContentDeleteEvent,
	ContentPublishStateChangeEvent,
	ContentRestoreStateChangeEvent,
	ContentScheduleStateChangeEvent,
	ContentStateChangeEvent,
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
	ContentBeforePublishHandler,
	ContentBeforeScheduleHandler,
	ContentBeforeUnpublishHandler,
	ContentAfterRestoreHandler,
	ContentAfterScheduleHandler,
	ContentAfterUnscheduleHandler,
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
	PluginComment,
	PluginCommentStatus,
	CommentAccess,
	CommentListOptions,
	CommentCountOptions,

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
	PluginEditorPanel,
	PluginEditorAction,
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
} from "./types.js";

// Capability normalization (legacy → canonical alias layer)
export {
	CAPABILITY_RENAMES,
	isDeprecatedCapability,
	normalizeCapability,
	normalizeCapabilities,
} from "./types.js";
export type { CurrentPluginCapability, DeprecatedPluginCapability } from "./types.js";
