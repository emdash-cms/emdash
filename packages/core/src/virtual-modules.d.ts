/**
 * Type declarations for EmDash virtual modules
 *
 * These modules are generated at build time by the Astro integration.
 * They provide static imports for configured adapters (database, storage, auth).
 */

declare module "virtual:emdash/config" {
	import type { I18nConfig } from "./i18n/config.js";
	import type {
		AuthDescriptor,
		AuthProviderDescriptor,
		DatabaseDescriptor,
		StorageDescriptor,
	} from "./index.js";

	interface VirtualConfig {
		database?: DatabaseDescriptor;
		storage?: StorageDescriptor;
		auth?: AuthDescriptor;
		authProviders?: AuthProviderDescriptor[];
		i18n?: I18nConfig | null;
		toolbar?: "server" | "client" | false;
		/** Public origin from astro.config.mjs, origin-normalized at startup. */
		siteUrl?: string;
		astroCspEnabled?: boolean;
	}

	const config: VirtualConfig;
	export default config;
}

declare module "virtual:emdash/dialect" {
	import type { Dialect, Kysely } from "kysely";

	import type { DatabaseDialectType } from "./db/adapters.js";

	// Can be undefined if no database configured, or the actual function
	export const createDialect: ((config: unknown) => Dialect) | undefined;
	export const dialectType: DatabaseDialectType | undefined;

	// Optional coalescing dialect for the runtime's cold-start read batch.
	// Only batching backends (D1, DO) export it; undefined otherwise.
	export const createCoalescingDialect: ((config: unknown) => Dialect | null) | undefined;

	/**
	 * Adapter-owned per-request scoping. Returns null when the configured
	 * adapter has no per-request semantics (non-D1, or D1 with sessions
	 * disabled). Otherwise returns a request-scoped Kysely and a commit
	 * callback to persist per-request state.
	 */
	export interface RequestScopedDbOpts {
		config: unknown;
		isAuthenticated: boolean;
		isWrite: boolean;
		cookies: {
			get(name: string): { value: string } | undefined;
			set(name: string, value: string, options: Record<string, unknown>): void;
		};
		url: URL;
	}
	export interface RequestScopedDb {
		db: Kysely<unknown>;
		commit: () => void;
		/**
		 * Optional teardown, invoked once the response body has fully streamed
		 * (or immediately for bodyless responses). Adapters that hold a real
		 * connection for the request (e.g. a Postgres pool over Hyperdrive) close
		 * it here — closing in `commit()` would cut the connection mid-render,
		 * because Astro streams the HTML body and components issue queries while
		 * it streams. Stateless adapters (D1) omit it.
		 */
		close?: () => void;
	}
	export const createRequestScopedDb: (opts: RequestScopedDbOpts) => RequestScopedDb | null;
}

declare module "virtual:emdash/storage" {
	import type { Storage } from "./storage/types.js";

	// Can be undefined if no storage configured, or the actual function
	export const createStorage: ((config: Record<string, unknown>) => Storage) | undefined;
}

declare module "virtual:emdash/object-cache" {
	import type {
		CreateObjectCacheBackendFn,
		ObjectCacheRuntimeConfig,
	} from "./object-cache/types.js";

	// Can be undefined if no object cache is configured.
	export const createObjectCache: CreateObjectCacheBackendFn | undefined;
	export const objectCacheConfig: ObjectCacheRuntimeConfig | undefined;
}

declare module "virtual:emdash/auth" {
	import type { AuthResult } from "./auth/types.js";

	// Can be undefined if no external auth configured, or the actual function
	export const authenticate:
		| ((request: Request, config: unknown) => Promise<AuthResult>)
		| undefined;
}

declare module "virtual:emdash/storage" {
	import type { Storage } from "./storage/types.js";

	export const createStorage: ((config: Record<string, unknown>) => Storage) | null;
}

declare module "virtual:emdash/auth" {
	import type { AuthResult } from "./auth/types.js";

	export const authenticate: ((request: Request, config: unknown) => Promise<AuthResult>) | null;
}

declare module "virtual:emdash/plugins" {
	import type { ResolvedPlugin } from "./plugins/types.js";

	export const plugins: ResolvedPlugin[];
}

declare module "virtual:emdash/sandbox-runner" {
	import type { SandboxRunner, SandboxRunnerFactory, SandboxOptions } from "./plugins/types.js";

	export const createSandboxRunner: SandboxRunnerFactory | null;
	export const CloudflareSandboxRunner: (new (options: SandboxOptions) => SandboxRunner) | null;
}

declare module "virtual:emdash/sandboxed-plugins" {
	import type { PluginDescriptor } from "./astro/integration/runtime.js";

	export const sandboxedPlugins: PluginDescriptor[];
}

declare module "virtual:emdash/block-components" {
	export const pluginBlockComponents: Record<string, unknown>;
}

declare module "virtual:emdash/auth-providers" {
	import type { ComponentType } from "react";

	interface AuthProviderEntry {
		id: string;
		label: string;
		LoginButton?: ComponentType;
		LoginForm?: ComponentType;
		SetupStep?: ComponentType<{ onComplete: () => void }>;
	}

	export const authProviders: Record<string, AuthProviderEntry>;
}

declare module "virtual:emdash/wait-until" {
	/**
	 * Optional host-provided lifetime extender for work deferred past the
	 * response. Resolves to Cloudflare's `waitUntil` under @astrojs/cloudflare;
	 * `undefined` on Node (fire-and-forget is safe on a long-lived process).
	 */
	export const waitUntil: ((promise: Promise<unknown>) => void) | undefined;
}

declare module "virtual:emdash/env" {
	/**
	 * Worker bindings/secrets. Resolves to Cloudflare's `env` (from
	 * `cloudflare:workers`) under @astrojs/cloudflare; `undefined` on Node,
	 * where callers should fall back to `import.meta.env`.
	 */
	export const env: Record<string, unknown> | undefined;
}

declare module "virtual:emdash/scheduler" {
	import type { CreateSchedulerFn } from "./emdash-runtime.js";
	/**
	 * Factory for the timer-based cron/maintenance heartbeat. A
	 * `NodeCronScheduler` factory on long-lived runtimes (Node/Bun); `null`
	 * under serverless adapters (e.g. Cloudflare) where an external Cron
	 * Trigger drives scheduled work instead.
	 */
	export const createScheduler: CreateSchedulerFn | null;
}

declare module "virtual:emdash/admin-registry" {
	/**
	 * Plugin admin module registry.
	 * Each entry is the namespace import of the plugin's admin entry module.
	 * Convention for exports:
	 *   - pages: Record<pageId, ComponentType>
	 *   - widgets: Record<widgetId, ComponentType>
	 *   - fields: Record<widgetName, ComponentType> (field widget renderers)
	 */
	export const pluginAdmins: Record<
		string,
		{
			pages?: Record<string, unknown>;
			widgets?: Record<string, unknown>;
			fields?: Record<string, unknown>;
		}
	>;
}
