// Main App
export { AdminApp, default as App } from "./App";

// Router
export { createAdminRouter, Link, useNavigate, useParams } from "./router";

// Components
export * from "./components";

// API client
export * from "./lib/api";

// Utilities
export { cn } from "./lib/utils";

// Plugin admin context (for accessing plugin components)
export {
	PluginAdminProvider,
	usePluginAdmins,
	usePluginWidget,
	usePluginPage,
	usePluginField,
	usePluginHasPages,
	usePluginHasWidgets,
	type PluginAdminModule,
	type PluginAdmins,
} from "./lib/plugin-context";

// Locales
export {
	useLocale,
	SUPPORTED_LOCALES,
	SUPPORTED_LOCALE_CODES,
	DEFAULT_LOCALE,
	resolveLocale,
} from "./locales/index.js";
export type { SupportedLocale } from "./locales/index.js";
