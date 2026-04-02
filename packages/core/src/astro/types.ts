/**
 * EmDash Astro types
 *
 * This file re-exports types from the core package and defines
 * the locals interface that the middleware provides.
 */

import type { Element } from "@emdash-cms/blocks";
import type { Kysely } from "kysely";

// Re-export core types
export type {
	ContentItem,
	MediaItem,
	ContentListResponse,
	ContentResponse,
	MediaListResponse,
	MediaResponse,
	Storage,
	Database,
} from "../index.js";

/**
 * Manifest collection definition
 */
export interface ManifestCollection {
	label: string;
	labelSingular: string;
	supports: string[];
	hasSeo: boolean;
	fields: Record<
		string,
		{
			kind: string;
			label?: string;
			required?: boolean;
			widget?: string;
			options?: Array<{ value: string; label: string }>;
		}
	>;
}

/**
 * Plugin manifest entry in the admin manifest
 */
export interface ManifestPlugin {
	version?: string;
	/** Package name for dynamic import (e.g., "@emdash-cms/plugin-audit-log") */
	package?: string;
	/** Whether the plugin is currently enabled */
	enabled?: boolean;
	/**
	 * How this plugin renders its admin UI:
	 * - "react": Trusted plugin with React components (default for trusted plugins)
	 * - "blocks": Declarative Block Kit UI via admin route handler
	 * - "none": No admin UI
	 */
	adminMode?: "react" | "blocks" | "none";
	adminPages?: Array<{
		path: string;
		label?: string;
		icon?: string;
	}>;
	dashboardWidgets?: Array<{
		id: string;
		title?: string;
		size?: string;
	}>;
	fieldWidgets?: Array<{
		name: string;
		label: string;
		fieldTypes: string[];
		elements?: Element[];
	}>;
	/** Portable Text block types provided by this plugin */
	portableTextBlocks?: Array<{
		type: string;
		label: string;
		icon?: string;
		description?: string;
		placeholder?: string;
		fields?: Element[];
	}>;
}

/**
 * Auth mode indicator for the admin UI
 * - "passkey": Built-in passkey authentication (default)
 * - string: External auth provider type (e.g., "cloudflare-access")
 */
export type ManifestAuthMode = string;

/**
 * The EmDash manifest provided to the admin UI
 */
export interface EmDashManifest {
	version: string;
	hash: string;
	collections: Record<string, ManifestCollection>;
	plugins: Record<string, ManifestPlugin>;
	/**
	 * Auth mode for the admin UI. When "passkey", the security settings
	 * (passkey management, self-signup domains) are shown. When using
	 * external auth (e.g., "cloudflare-access"), these are hidden since
	 * authentication is handled externally.
	 */
	authMode: ManifestAuthMode;
	/**
	 * Whether self-signup is enabled (at least one allowed domain is active).
	 * Used by the login page to conditionally show the "Sign up" link.
	 */
	signupEnabled?: boolean;
	/**
	 * i18n configuration from Astro config.
	 * Only present when i18n is enabled (multiple locales configured).
	 */
	i18n?: {
		defaultLocale: string;
		locales: string[];
		prefixDefaultLocale?: boolean;
	};
	/**
	 * Whether the plugin marketplace is configured.
	 * When true, the admin UI can show marketplace browse/install features.
	 */
	marketplace?: boolean;
}

/**
 * Standard handler response shape used by all EmDashHandlers methods.
 *
 * The error shape matches `ApiResult` from the core package — typing it
 * here lets route files use `result.error?.code` without unsafe casts while
 * keeping the data side loosely coupled (defaults to `unknown`).
 */
export interface HandlerResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

/**
 * The EmDash API handlers provided via Astro.locals
 *
 * Data types default to `unknown` to avoid tight coupling with the core
 * package. Handlers whose data shape is accessed in route files (e.g.
 * handleContentGet, handleRevisionGet) use narrower types.
 */
export interface EmDashHandlers {
	// Content handlers
	handleContentList: (
		collection: string,
		params: {
			cursor?: string;
			limit?: number;
			status?: string;
			orderBy?: string;
			order?: "asc" | "desc";
			locale?: string;
		},
	) => Promise<HandlerResponse>;

	handleContentGet: (
		collection: string,
		id: string,
		locale?: string,
	) => Promise<
		HandlerResponse<{
			item: {
				id: string;
				authorId: string | null;
				[key: string]: unknown;
			};
			_rev?: string;
		}>
	>;

	handleContentCreate: (
		collection: string,
		body: {
			data: Record<string, unknown>;
			slug?: string;
			status?: string;
			authorId?: string;
			locale?: string;
			translationOf?: string;
		},
	) => Promise<HandlerResponse>;

	handleContentUpdate: (
		collection: string,
		id: string,
		body: {
			data?: Record<string, unknown>;
			slug?: string;
			status?: string;
			authorId?: string | null;
			_rev?: string;
		},
	) => Promise<HandlerResponse>;

	handleContentDelete: (collection: string, id: string) => Promise<HandlerResponse>;

	// Trash handlers
	handleContentListTrashed: (
		collection: string,
		params?: { cursor?: string; limit?: number },
	) => Promise<HandlerResponse>;

	handleContentRestore: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentPermanentDelete: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentCountTrashed: (collection: string) => Promise<HandlerResponse>;

	handleContentGetIncludingTrashed: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentDuplicate: (
		collection: string,
		id: string,
		authorId?: string,
	) => Promise<HandlerResponse>;

	// Publishing & Scheduling handlers
	handleContentPublish: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentUnpublish: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentSchedule: (
		collection: string,
		id: string,
		scheduledAt: string,
	) => Promise<HandlerResponse>;

	handleContentUnschedule: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentCountScheduled: (collection: string) => Promise<HandlerResponse>;

	handleContentDiscardDraft: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentCompare: (collection: string, id: string) => Promise<HandlerResponse>;

	handleContentTranslations: (collection: string, id: string) => Promise<HandlerResponse>;

	// Media handlers
	handleMediaList: (params: {
		cursor?: string;
		limit?: number;
		mimeType?: string;
	}) => Promise<HandlerResponse>;

	handleMediaGet: (id: string) => Promise<HandlerResponse>;

	handleMediaCreate: (input: {
		filename: string;
		mimeType: string;
		size?: number;
		width?: number;
		height?: number;
		storageKey: string;
		contentHash?: string;
		blurhash?: string;
		dominantColor?: string;
		authorId?: string;
	}) => Promise<HandlerResponse>;

	handleMediaUpdate: (
		id: string,
		input: { alt?: string; caption?: string; width?: number; height?: number },
	) => Promise<HandlerResponse>;

	handleMediaDelete: (id: string) => Promise<HandlerResponse>;

	// Revision handlers
	handleRevisionList: (
		collection: string,
		entryId: string,
		params?: { limit?: number },
	) => Promise<HandlerResponse>;

	handleRevisionGet: (revisionId: string) => Promise<
		HandlerResponse<{
			item: {
				id: string;
				collection: string;
				entryId: string;
				authorId: string | null;
				[key: string]: unknown;
			};
		}>
	>;

	handleRevisionRestore: (revisionId: string, callerUserId: string) => Promise<HandlerResponse>;

	// Plugin API route handler
	handlePluginApiRoute: (
		pluginId: string,
		method: string,
		path: string,
		request: Request,
	) => Promise<HandlerResponse>;

	// Plugin route metadata (for auth decisions before dispatch)
	getPluginRouteMeta: (pluginId: string, path: string) => { public: boolean } | null;

	// Media provider handlers
	getMediaProvider: (providerId: string) => import("../media/types.js").MediaProvider | undefined;
	getMediaProviderList: () => Array<{
		id: string;
		name: string;
		icon?: string;
		capabilities: import("../media/types.js").MediaProviderCapabilities;
	}>;

	// Direct access to storage and database for advanced use cases
	storage: import("../index.js").Storage | null;
	db: Kysely<import("../index.js").Database>;

	// Hook pipeline for plugin integrations
	hooks: import("../plugins/hooks.js").HookPipeline;

	// Email pipeline for sending emails through the plugin system
	email: import("../plugins/email.js").EmailPipeline | null;

	// Configured plugins (for plugin management)
	configuredPlugins: import("../plugins/types.js").ResolvedPlugin[];

	// Configuration (for checking database type, auth mode, etc.)
	config: import("./integration/runtime.js").EmDashConfig;

	// Manifest invalidation (call after schema changes)
	invalidateManifest: () => void;

	// Sandbox runner (for marketplace plugin install/update)
	getSandboxRunner: () => import("../plugins/sandbox/types.js").SandboxRunner | null;

	// Sync marketplace plugin states (after install/update/uninstall)
	syncMarketplacePlugins: () => Promise<void>;

	// Update plugin enabled/disabled status and rebuild hook pipeline
	setPluginStatus: (pluginId: string, status: "active" | "inactive") => Promise<void>;

	// Page contribution methods (for EmDashHead/EmDashBodyStart/EmDashBodyEnd)
	collectPageMetadata: (
		page: import("../plugins/types.js").PublicPageContext,
	) => Promise<import("../plugins/types.js").PageMetadataContribution[]>;
	collectPageFragments: (
		page: import("../plugins/types.js").PublicPageContext,
	) => Promise<import("../plugins/types.js").PageFragmentContribution[]>;
}
