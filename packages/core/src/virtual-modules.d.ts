/**
 * Type declarations for EmDash virtual modules
 *
 * These modules are generated at build time by the Astro integration.
 * They provide static imports for configured adapters (database, storage, auth).
 */

declare module "virtual:emdash/config" {
	import type { I18nConfig } from "./i18n/config.js";
	import type { DatabaseDescriptor, StorageDescriptor, AuthDescriptor } from "./index.js";

	interface VirtualConfig {
		database?: DatabaseDescriptor;
		storage?: StorageDescriptor;
		auth?: AuthDescriptor;
		i18n?: I18nConfig | null;
		totp?: {
			enabled?: boolean;
			issuer?: string;
		};
	}

	const config: VirtualConfig;
	export default config;
}

declare module "virtual:emdash/dialect" {
	import type { Dialect } from "kysely";

	import type { DatabaseDialectType } from "./db/adapters.js";

	// Can be undefined if no database configured, or the actual function
	export const createDialect: ((config: unknown) => Dialect) | undefined;
	export const dialectType: DatabaseDialectType | undefined;

	// D1 read replica session helpers (no-ops for non-D1 adapters).
	// Types use `unknown` because the core package doesn't depend on
	// @cloudflare/workers-types — the actual D1Database types are resolved
	// at bundle time in the cloudflare adapter.
	export const isSessionEnabled: (config: unknown) => boolean;
	export const getD1Binding: (config: unknown) => unknown;
	export const getDefaultConstraint: (config: unknown) => string;
	export const getBookmarkCookieName: (config: unknown) => string;
	export const createSessionDialect: ((database: unknown) => Dialect) | undefined;
}

declare module "virtual:emdash/storage" {
	import type { Storage } from "./storage/types.js";

	// Can be undefined if no storage configured, or the actual function
	export const createStorage: ((config: Record<string, unknown>) => Storage) | undefined;
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
